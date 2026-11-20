//! The signalling hub: one phone, any number of viewers (the OBS source and the
//! preview in the app window). It only relays the WebRTC handshake; the video
//! itself goes straight from the phone to each viewer.
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch, Notify};

pub type Rx = mpsc::UnboundedReceiver<String>;
type Tx = mpsc::UnboundedSender<String>;

/// Everything the app window shows.
#[derive(Clone, PartialEq, Serialize, Default)]
pub struct UiState {
    /// What the QR code holds; empty while this computer has no network.
    pub url: String,
    pub qr: String,
    pub view_url: String,
    pub phone: bool,
    /// "off", "disabled", "auth" or "ready".
    pub obs: &'static str,
    pub source: bool,
    pub vcam: bool,
    /// The page inside OBS is open and talking to Lens.
    pub obs_page: bool,
    /// That page is showing the phone's picture.
    pub obs_live: bool,
    /// The newer version waiting to be installed; empty when up to date.
    pub update: String,
    pub updating: bool,
    /// The version of this Lens, shown in a corner of the window.
    pub version: &'static str,
}

/// Changes the state and wakes its listeners only when something changed.
pub fn update(ui: &watch::Sender<UiState>, change: impl FnOnce(&mut UiState)) {
    ui.send_if_modified(|state| {
        let before = state.clone();
        change(state);
        *state != before
    });
}

/// A phone that has said nothing for this long is asleep or out of reach.
const PHONE_SILENCE: Duration = Duration::from_secs(15);

struct Viewer {
    tx: Tx,
    /// The page inside OBS, as opposed to the preview in the app window.
    obs: bool,
    live: bool,
}

#[derive(Default)]
struct Inner {
    last_id: u64,
    phone: Option<(u64, Tx, Instant)>,
    viewers: HashMap<u64, Viewer>,
}

pub struct Hub {
    inner: Mutex<Inner>,
    pub ui: watch::Sender<UiState>,
    /// The size the app window's page actually got, as the page reports it.
    pub fit: watch::Sender<(f64, f64)>,
    /// Rung when the person asks for the waiting update.
    pub install: Notify,
    /// Travels in the QR code, so only someone who saw the screen can send video.
    pub token: String,
}

fn send(tx: &Tx, message: Value) {
    let _ = tx.send(message.to_string());
}

impl Hub {
    pub fn new(token: String, ui: UiState) -> Self {
        Self {
            inner: Mutex::default(),
            ui: watch::Sender::new(ui),
            fit: watch::Sender::new((0.0, 0.0)),
            install: Notify::new(),
            token,
        }
    }

    /// A newly scanned phone takes over from the one before it.
    pub fn join_phone(&self) -> (u64, Rx) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().unwrap();
        inner.last_id += 1;
        let id = inner.last_id;
        if let Some((_, old, _)) = inner.phone.take() {
            send(&old, json!({ "type": "replaced" }));
        }
        send(&tx, json!({ "type": "hello", "id": id }));
        for (viewer_id, viewer) in &inner.viewers {
            send(&viewer.tx, json!({ "type": "phone-left" }));
            send(&tx, json!({ "type": "viewer-joined", "id": viewer_id }));
        }
        inner.phone = Some((id, tx, Instant::now()));
        drop(inner);
        update(&self.ui, |state| state.phone = true);
        (id, rx)
    }

    /// Tells the app window what the page inside OBS is doing.
    fn report_obs(&self, inner: &Inner) {
        let page = inner.viewers.values().any(|viewer| viewer.obs);
        let live = inner.viewers.values().any(|viewer| viewer.obs && viewer.live);
        update(&self.ui, |state| {
            state.obs_page = page;
            state.obs_live = live;
        });
    }

    /// A viewer says whether it is showing the picture.
    pub fn set_live(&self, id: u64, live: bool) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(viewer) = inner.viewers.get_mut(&id) else { return false };
        viewer.live = live;
        self.report_obs(&inner);
        true
    }

    /// The phone says it is still there.
    pub fn touch(&self, id: u64) -> bool {
        match self.inner.lock().unwrap().phone.as_mut() {
            Some((phone, _, seen)) if *phone == id => {
                *seen = Instant::now();
                true
            }
            _ => false,
        }
    }

    /// Lets go of a phone that went quiet: a sleeping phone keeps its
    /// connection open for minutes, and the window should not call that connected.
    pub fn reap(&self) {
        let silent = self
            .inner
            .lock()
            .unwrap()
            .phone
            .as_ref()
            .and_then(|(id, _, seen)| (seen.elapsed() > PHONE_SILENCE).then_some(*id));
        if let Some(id) = silent {
            self.leave(id);
        }
    }

    pub fn join_viewer(&self, obs: bool) -> (u64, Rx) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().unwrap();
        inner.last_id += 1;
        let id = inner.last_id;
        send(&tx, json!({ "type": "hello", "id": id }));
        if let Some((_, phone, _)) = &inner.phone {
            send(phone, json!({ "type": "viewer-joined", "id": id }));
        }
        inner.viewers.insert(id, Viewer { tx, obs, live: false });
        self.report_obs(&inner);
        (id, rx)
    }

    pub fn leave(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.phone.as_ref().is_some_and(|(phone, _, _)| *phone == id) {
            inner.phone = None;
            for viewer in inner.viewers.values() {
                send(&viewer.tx, json!({ "type": "phone-left" }));
            }
            drop(inner);
            update(&self.ui, |state| state.phone = false);
        } else if inner.viewers.remove(&id).is_some() {
            if let Some((_, phone, _)) = &inner.phone {
                send(phone, json!({ "type": "viewer-left", "id": id }));
            }
            self.report_obs(&inner);
        }
    }

    /// The phone writes to one viewer; a viewer can only write to the phone.
    /// `from_phone` says which side the request came in on, so neither can
    /// pose as the other. False when the sender is not who it claims to be.
    pub fn signal(&self, from: u64, from_phone: bool, to: Option<u64>, data: Value) -> bool {
        let inner = self.inner.lock().unwrap();
        let phone = inner.phone.as_ref();
        let message = json!({ "type": "signal", "from": from, "data": data });
        if from_phone {
            if phone.is_none_or(|(id, _, _)| *id != from) {
                return false;
            }
            if let Some(viewer) = to.and_then(|id| inner.viewers.get(&id)) {
                send(&viewer.tx, message);
            }
            true
        } else {
            if !inner.viewers.contains_key(&from) {
                return false;
            }
            if let Some((_, phone, _)) = phone {
                send(phone, message);
            }
            true
        }
    }
}
