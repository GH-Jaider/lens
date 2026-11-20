//! Two listeners. The local one (plain HTTP, this computer only) serves the app
//! window and the page OBS loads. The network one (HTTPS) serves the phone.
use std::{
    convert::Infallible,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use axum::{
    extract::{Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use futures_util::{Stream, StreamExt};
use qrcode::{render::svg, QrCode};
use serde::Deserialize;
use serde_json::Value;
use tokio_stream::wrappers::{UnboundedReceiverStream, WatchStream};

use crate::{
    hub::{update, Hub, UiState},
    obs, tls,
};

/// Fixed, so the link saved in an OBS scene keeps working between launches.
const LOCAL_PORT: u16 = 47800;
const PHONE_PORT: u16 = 47810;

pub struct Started {
    pub local_port: u16,
    pub phone_port: u16,
    pub token: String,
    pub hub: Arc<Hub>,
}

#[derive(Clone)]
struct Ctx {
    hub: Arc<Hub>,
    /// True on the listener the phone reaches.
    phone_side: bool,
}

#[derive(Deserialize)]
struct Params {
    t: Option<String>,
    id: Option<u64>,
    /// Set by the page inside OBS, so the window can say what OBS is showing.
    obs: Option<u8>,
    on: Option<u8>,
    w: Option<f64>,
    h: Option<f64>,
}

#[derive(Deserialize)]
struct Signal {
    to: Option<u64>,
    data: Value,
}

/// Tells the hub when a page goes away, however the connection ended.
struct Leave(Arc<Hub>, u64);

impl Drop for Leave {
    fn drop(&mut self) {
        self.0.leave(self.1);
    }
}

fn bind(ip: Ipv4Addr, preferred: u16) -> Result<TcpListener, String> {
    for port in preferred..preferred + 10 {
        if let Ok(listener) = TcpListener::bind((ip, port)) {
            listener.set_nonblocking(true).map_err(|error| error.to_string())?;
            return Ok(listener);
        }
    }
    Err(format!("Ports {preferred} to {} are all in use.", preferred + 9))
}

/// This computer's address on the network, without sending anything: asking
/// for a route is enough to learn which address would be used.
fn network_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn random_token() -> String {
    let mut bytes = [0u8; 12];
    getrandom::getrandom(&mut bytes).expect("the system has a random source");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn qr_svg(url: &str) -> String {
    QrCode::new(url)
        .map(|code| code.render::<svg::Color>().min_dimensions(240, 240).quiet_zone(false).build())
        .unwrap_or_default()
}

pub async fn start(data_dir: PathBuf, with_obs: bool) -> Result<Started, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let local = bind(Ipv4Addr::LOCALHOST, LOCAL_PORT)?;
    let phone = bind(Ipv4Addr::UNSPECIFIED, PHONE_PORT)?;
    let local_port = local.local_addr().map_err(|error| error.to_string())?.port();
    let phone_port = phone.local_addr().map_err(|error| error.to_string())?.port();

    let token = random_token();
    let view_url = format!("http://127.0.0.1:{local_port}/view");
    let hub = Arc::new(Hub::new(
        token.clone(),
        UiState { view_url: view_url.clone(), obs: "off", ..UiState::default() },
    ));

    let (cert, key) = tls::cert_for(&data_dir, IpAddr::V4(Ipv4Addr::LOCALHOST))?;
    let tls = RustlsConfig::from_pem(cert, key).await.map_err(|error| error.to_string())?;

    let local_app = Router::new()
        .route("/", get(|| async { Html(include_str!("../web/index.html")) }))
        .route("/view", get(|| async { Html(include_str!("../web/view.html")) }))
        .route("/viewer.js", get(viewer_js))
        .route("/state", get(state))
        .route("/events", get(events))
        .route("/signal", post(signal))
        .route("/live", post(live))
        .route("/fit", post(fit))
        .route("/update", post(install))
        .layer(middleware::from_fn(local_only))
        .with_state(Ctx { hub: hub.clone(), phone_side: false });
    let phone_app = Router::new()
        .route("/", get(|| async { Html(include_str!("../web/phone.html")) }))
        .route("/events", get(events))
        .route("/signal", post(signal))
        .route("/ping", post(ping))
        .with_state(Ctx { hub: hub.clone(), phone_side: true });

    let local = tokio::net::TcpListener::from_std(local).map_err(|error| error.to_string())?;
    tokio::spawn(async move {
        let _ = axum::serve(local, local_app).await;
    });
    let phone_tls = tls.clone();
    tokio::spawn(async move {
        let _ = axum_server::from_tcp_rustls(phone, phone_tls).serve(phone_app.into_make_service()).await;
    });
    tokio::spawn(follow_network(hub.clone(), tls, data_dir, phone_port));
    if with_obs {
        tokio::spawn(obs::run(hub.ui.clone(), view_url));
    }

    Ok(Started { local_port, phone_port, token, hub })
}

/// Keeps the QR code pointing at this computer as it joins or changes network.
async fn follow_network(hub: Arc<Hub>, tls: RustlsConfig, data_dir: PathBuf, port: u16) {
    let mut current = None;
    loop {
        hub.reap();
        let ip = network_ip();
        if ip != current {
            current = ip;
            let url = match ip {
                Some(ip) => {
                    if let Ok((cert, key)) = tls::cert_for(&data_dir, ip) {
                        let _ = tls.reload_from_pem(cert, key).await;
                    }
                    format!("https://{}/?t={}", SocketAddr::new(ip, port), hub.token)
                }
                None => String::new(),
            };
            let qr = if url.is_empty() { String::new() } else { qr_svg(&url) };
            update(&hub.ui, |state| {
                state.url = url;
                state.qr = qr;
            });
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
    }
}

/// The local pages show the camera, so no other site may reach them by
/// pointing a name of its own at this computer.
async fn local_only(request: Request, next: Next) -> Response {
    let host = request.headers().get(header::HOST).and_then(|value| value.to_str().ok()).unwrap_or("");
    if host.starts_with("127.0.0.1:") || host.starts_with("localhost:") {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

async fn viewer_js() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/viewer.js"))
}

fn stream_of<S>(stream: S) -> Sse<impl Stream<Item = Result<Event, Infallible>>>
where
    S: Stream<Item = String> + Send + 'static,
{
    Sse::new(stream.map(|data| Ok(Event::default().data(data))))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}

async fn state(State(ctx): State<Ctx>) -> impl IntoResponse {
    let states = WatchStream::new(ctx.hub.ui.subscribe());
    stream_of(states.map(|state| serde_json::to_string(&state).unwrap_or_default()))
}

async fn events(State(ctx): State<Ctx>, Query(params): Query<Params>) -> Response {
    let (id, rx) = if ctx.phone_side {
        if params.t.as_deref() != Some(ctx.hub.token.as_str()) {
            return StatusCode::FORBIDDEN.into_response();
        }
        ctx.hub.join_phone()
    } else {
        ctx.hub.join_viewer(params.obs == Some(1))
    };
    let leave = Leave(ctx.hub.clone(), id);
    stream_of(UnboundedReceiverStream::new(rx).map(move |message| {
        let _ = &leave;
        message
    }))
    .into_response()
}

async fn signal(State(ctx): State<Ctx>, Query(params): Query<Params>, Json(body): Json<Signal>) -> StatusCode {
    if ctx.phone_side && params.t.as_deref() != Some(ctx.hub.token.as_str()) {
        return StatusCode::FORBIDDEN;
    }
    let Some(from) = params.id else { return StatusCode::BAD_REQUEST };
    if ctx.hub.signal(from, ctx.phone_side, body.to, body.data) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::GONE
    }
}

async fn live(State(ctx): State<Ctx>, Query(params): Query<Params>) -> StatusCode {
    match params.id {
        Some(id) if ctx.hub.set_live(id, params.on == Some(1)) => StatusCode::NO_CONTENT,
        _ => StatusCode::GONE,
    }
}

async fn ping(State(ctx): State<Ctx>, Query(params): Query<Params>) -> StatusCode {
    if params.t.as_deref() != Some(ctx.hub.token.as_str()) {
        return StatusCode::FORBIDDEN;
    }
    match params.id {
        Some(id) if ctx.hub.touch(id) => StatusCode::NO_CONTENT,
        _ => StatusCode::GONE,
    }
}

async fn fit(State(ctx): State<Ctx>, Query(params): Query<Params>) -> StatusCode {
    let _ = ctx.hub.fit.send((params.w.unwrap_or(0.0), params.h.unwrap_or(0.0)));
    StatusCode::NO_CONTENT
}

async fn install(State(ctx): State<Ctx>) -> StatusCode {
    ctx.hub.install.notify_one();
    StatusCode::NO_CONTENT
}
