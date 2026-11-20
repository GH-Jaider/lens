//! Talks to the OBS on this computer over its WebSocket server (protocol v5).
//! When a phone connects, Lens adds its video to the current scene and turns
//! on the OBS virtual camera, so other apps see the phone as a camera.
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{net::TcpStream, sync::watch};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::hub::{update, UiState};

const SOURCE: &str = "Lens";

struct Settings {
    enabled: bool,
    port: u16,
    password: String,
}

/// OBS 28+ keeps its WebSocket settings here, so nobody has to copy a password.
fn settings() -> Option<Settings> {
    let tail = "obs-studio/plugin_config/obs-websocket/config.json";
    let home = PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?);
    let file = if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(tail)
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming")).join(tail)
    } else {
        // An OBS installed from Flathub keeps its settings in its own folder.
        let usual =
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join(tail);
        let flatpak = home.join(".var/app/com.obsproject.Studio/config").join(tail);
        if !usual.exists() && flatpak.exists() {
            flatpak
        } else {
            usual
        }
    };
    let raw: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let auth = raw["auth_required"].as_bool() != Some(false);
    Some(Settings {
        enabled: raw["server_enabled"].as_bool() == Some(true),
        port: raw["server_port"].as_u64().and_then(|port| u16::try_from(port).ok()).unwrap_or(4455),
        password: if auth { raw["server_password"].as_str().unwrap_or("").to_string() } else { String::new() },
    })
}

enum Fail {
    /// OBS went away.
    Closed,
    /// OBS answered that it could not do it.
    Refused,
}

struct Obs {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Obs {
    async fn read(&mut self) -> Result<Value, Fail> {
        loop {
            let message = self.socket.next().await.ok_or(Fail::Closed)?.map_err(|_| Fail::Closed)?;
            match message {
                Message::Text(_) => {
                    let text = message.into_text().map_err(|_| Fail::Closed)?;
                    return serde_json::from_str(text.as_ref()).map_err(|_| Fail::Closed);
                }
                Message::Close(_) => return Err(Fail::Closed),
                _ => {}
            }
        }
    }

    async fn write(&mut self, value: Value) -> Result<(), Fail> {
        self.socket.send(Message::Text(value.to_string().into())).await.map_err(|_| Fail::Closed)
    }

    async fn request(&mut self, kind: &str, data: Value) -> Result<Value, Fail> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.write(json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } })).await?;
        loop {
            let reply = self.read().await?;
            if reply["op"] == 7 && reply["d"]["requestId"] == id.as_str() {
                return if reply["d"]["requestStatus"]["result"] == true {
                    Ok(reply["d"]["responseData"].clone())
                } else {
                    Err(Fail::Refused)
                };
            }
        }
    }

    /// Whether the scene collection has the Lens source.
    async fn has_source(&mut self) -> Result<bool, Fail> {
        let list = self.request("GetInputList", json!({})).await?;
        Ok(list["inputs"].as_array().is_some_and(|inputs| inputs.iter().any(|input| input["inputName"] == SOURCE)))
    }

    async fn camera_on(&mut self) -> Result<bool, Fail> {
        match self.request("GetVirtualCamStatus", json!({})).await {
            Ok(status) => Ok(status["outputActive"] == true),
            Err(Fail::Refused) => Ok(false),
            Err(Fail::Closed) => Err(Fail::Closed),
        }
    }

    /// Points the source at an address; OBS loads the page when it changes.
    /// Only OBS going away is a failure: a refusal leaves things as they were.
    async fn point(&mut self, url: &str) -> Result<(), Fail> {
        let settings = json!({ "inputName": SOURCE, "inputSettings": { "url": url }, "overlay": true });
        match self.request("SetInputSettings", settings).await {
            Err(Fail::Closed) => Err(Fail::Closed),
            _ => Ok(()),
        }
    }

    /// Puts the phone in the current scene, filling the canvas, and turns the
    /// virtual camera on. A source the user already has is only re-pointed,
    /// never moved or resized.
    async fn show_phone(&mut self, view_url: &str) -> Result<(), Fail> {
        let outcome = if self.has_source().await? {
            let settings = json!({ "inputName": SOURCE, "inputSettings": { "url": view_url }, "overlay": true });
            self.request("SetInputSettings", settings).await
        } else {
            let scene = self.request("GetCurrentProgramScene", json!({})).await?;
            let video = self.request("GetVideoSettings", json!({})).await?;
            let input = json!({
                "sceneName": scene["sceneName"],
                "inputName": SOURCE,
                "inputKind": "browser_source",
                "inputSettings": {
                    "url": view_url,
                    "width": video["baseWidth"].as_u64().unwrap_or(1920),
                    "height": video["baseHeight"].as_u64().unwrap_or(1080),
                },
                "sceneItemEnabled": true,
            });
            self.request("CreateInput", input).await
        };
        if matches!(outcome, Err(Fail::Closed)) {
            return Err(Fail::Closed);
        }
        if !self.camera_on().await? {
            if let Err(Fail::Closed) = self.request("StartVirtualCam", json!({})).await {
                return Err(Fail::Closed);
            }
        }
        Ok(())
    }
}

/// OBS's challenge: base64(sha256(base64(sha256(password + salt)) + challenge)).
fn answer(password: &str, salt: &str, challenge: &str) -> String {
    let secret = STANDARD.encode(Sha256::digest(format!("{password}{salt}")));
    STANDARD.encode(Sha256::digest(format!("{secret}{challenge}")))
}

/// One connection to OBS, for as long as it lasts. Returns why it ended.
async fn session(ui: &watch::Sender<UiState>, view_url: &str, launch: &str) -> &'static str {
    let Some(settings) = settings() else { return "off" };
    let Ok((socket, _)) = connect_async(format!("ws://127.0.0.1:{}", settings.port)).await else {
        // OBS shut means off; OBS open with its server unticked looks the same
        // from here, and its own settings file tells the two apart.
        return if settings.enabled { "off" } else { "disabled" };
    };
    let mut obs = Obs { socket, next_id: 0 };

    let Ok(hello) = obs.read().await else { return "off" };
    let mut identify = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
    if let (Some(salt), Some(challenge)) =
        (hello["d"]["authentication"]["salt"].as_str(), hello["d"]["authentication"]["challenge"].as_str())
    {
        identify["authentication"] = answer(&settings.password, salt, challenge).into();
    }
    if obs.write(json!({ "op": 1, "d": identify })).await.is_err() {
        return "off";
    }
    match obs.read().await {
        Ok(reply) if reply["op"] == 2 => {}
        _ => return "auth",
    }
    update(ui, |state| state.obs = "ready");

    let mut changes = ui.subscribe();
    let mut had_phone = false;
    // The address carries this launch, so OBS loads the page afresh once per
    // launch: a page left over from an earlier Lens runs older code and has
    // been seen to sit there connected but showing nothing.
    let mut url = format!("{view_url}?s={launch}");
    let mut pointed = false;
    let mut reloads = 0;
    let mut unwell: Option<Instant> = None;
    loop {
        let (phone, page, live) = {
            let state = changes.borrow_and_update();
            (state.phone, state.obs_page, state.obs_live)
        };
        if phone && !had_phone {
            if obs.show_phone(&url).await.is_err() {
                return "off";
            }
            pointed = true;
        }
        had_phone = phone;
        let (Ok(source), Ok(vcam)) = (obs.has_source().await, obs.camera_on().await) else { return "off" };
        update(ui, |state| {
            state.source = source;
            state.vcam = vcam;
        });
        if source && !pointed {
            pointed = true;
            if obs.point(&url).await.is_err() {
                return "off";
            }
        }

        // OBS has the source but it is not doing its part: its page is not
        // talking to Lens (OBS was opened first and shows an error page that
        // never retries), or it is, and the phone is there, yet no picture
        // shows. Only a different address makes OBS load the page again.
        if source && (!page || (phone && !live)) {
            let patience = Duration::from_secs(if page { 10 } else { 4 });
            let since = *unwell.get_or_insert_with(Instant::now);
            if since.elapsed() > patience && reloads < 3 {
                reloads += 1;
                unwell = None;
                url = format!("{view_url}?s={launch}-{reloads}");
                if obs.point(&url).await.is_err() {
                    return "off";
                }
            }
        } else {
            unwell = None;
            if source {
                reloads = 0;
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = changes.changed() => {}
        }
    }
}

/// Keeps looking for OBS for as long as Lens runs.
pub async fn run(ui: watch::Sender<UiState>, view_url: String, launch: String) {
    loop {
        let ended = session(&ui, &view_url, &launch).await;
        update(&ui, |state| {
            state.obs = ended;
            state.source = false;
            state.vcam = false;
        });
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
