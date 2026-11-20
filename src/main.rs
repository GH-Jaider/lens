#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hub;
mod obs;
mod server;
mod tls;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_updater::UpdaterExt;

use crate::hub::Hub;

/// The size the page is designed for. The window is sized around it.
const PAGE: (f64, f64) = (368.0, 616.0);

/// Without a menu bar or tray item there is nowhere to come back from, so
/// closing the window then has to end Lens.
static HAS_TRAY: AtomicBool = AtomicBool::new(false);

struct LocalPort(u16);

fn main() {
    if std::env::args().any(|arg| arg == "--headless") {
        return headless();
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_window(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Without a folder of its own Lens still runs; the phone only warns
            // about the certificate again next time.
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("lens"));
            // The tests start the real app, and must not touch the scenes of an
            // OBS that happens to be open.
            let with_obs = std::env::var_os("LENS_NO_OBS").is_none();
            let started = tauri::async_runtime::block_on(server::start(data_dir, with_obs))?;
            app.manage(LocalPort(started.local_port));

            let handle = app.handle().clone();
            let mut fit = started.hub.fit.subscribe();
            tauri::async_runtime::spawn(async move {
                while fit.changed().await.is_ok() {
                    let (width, height) = *fit.borrow_and_update();
                    fit_window(&handle, width, height);
                }
            });
            tauri::async_runtime::spawn(follow_updates(app.handle().clone(), started.hub));

            // Some Linux desktops have no tray at all; Lens still works there.
            HAS_TRAY.store(add_tray(app).is_ok(), Ordering::Relaxed);
            open_window(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Lens could not start");

    app.run(|app, event| match event {
        // Closing the window leaves Lens in the menu bar, so the camera keeps
        // working; only Quit (which passes an exit code) really ends it.
        RunEvent::ExitRequested { api, code: None, .. } if HAS_TRAY.load(Ordering::Relaxed) => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => open_window(app),
        _ => {
            let _ = app;
        }
    });
}

fn spanish() -> bool {
    sys_locale::get_locale().is_some_and(|locale| locale.to_lowercase().starts_with("es"))
}

fn add_tray(app: &tauri::App) -> tauri::Result<()> {
    let (open, quit) = if spanish() { ("Abrir Lens", "Salir de Lens") } else { ("Open Lens", "Quit Lens") };
    // Not a command: it only says which version this is.
    let version = MenuItem::with_id(app, "version", concat!("Lens ", env!("CARGO_PKG_VERSION")), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    let tray = TrayIconBuilder::new()
        .tooltip("Lens")
        .menu(&Menu::with_items(app, &[&version, &open, &quit])?)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_window(app),
            "quit" => app.exit(0),
            _ => {}
        });

    // The Mac menu bar tints a plain mark itself; a Windows or Linux tray
    // shows the icon as it is, and there a click is expected to open the app.
    #[cfg(target_os = "macos")]
    let tray = tray.icon(tray_mark()).icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray = {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        let tray = match app.default_window_icon() {
            Some(icon) => tray.icon(icon.clone()),
            None => tray,
        };
        tray.show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                open_window(tray.app_handle());
            }
        })
    };

    tray.build(app)?;
    Ok(())
}

/// The window is only a view of the local page, and is thrown away when
/// closed, so Lens costs little while it waits in the menu bar.
fn open_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let port = app.state::<LocalPort>().0;
    let Ok(url) = format!("http://127.0.0.1:{port}/").parse() else { return };
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Lens")
        .inner_size(PAGE.0, PAGE.1)
        .resizable(false)
        .maximizable(false)
        .visible(false)
        .build();
    // The page says how big it came out and the window is shown once it fits;
    // should the page never say, the window shows anyway.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
        }
    });
}

/// How much room a title bar takes differs between systems, so the page
/// reports the size it really got and the window grows or shrinks by the
/// difference. Nothing is ever cut off, whatever the system draws around it.
fn fit_window(app: &AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window("main") else { return };
    let (extra_width, extra_height) = (PAGE.0 - width, PAGE.1 - height);
    if width > 0.0 && height > 0.0 && (extra_width.abs() > 0.5 || extra_height.abs() > 0.5) {
        if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
            let size = size.to_logical::<f64>(scale);
            let _ = window.set_size(LogicalSize::new(size.width + extra_width, size.height + extra_height));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Looks for a newer release now and then. The window offers it; nothing is
/// downloaded until the person asks.
async fn follow_updates(app: AppHandle, hub: Arc<Hub>) {
    loop {
        let found = match app.updater() {
            Ok(updater) => updater.check().await.ok().flatten(),
            Err(_) => None,
        };
        if let Some(update) = found {
            hub::update(&hub.ui, |state| state.update = update.version.clone());
            loop {
                hub.install.notified().await;
                hub::update(&hub.ui, |state| state.updating = true);
                if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                    app.restart();
                }
                hub::update(&hub.ui, |state| state.updating = false);
            }
        }
        tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
    }
}

/// The menu bar mark, drawn here so it needs no image file: a ring and a dot.
#[cfg(target_os = "macos")]
fn tray_mark() -> tauri::image::Image<'static> {
    const SIZE: usize = 44;
    let centre = (SIZE as f32 - 1.0) / 2.0;
    let mut pixels = vec![0u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let distance = ((x as f32 - centre).powi(2) + (y as f32 - centre).powi(2)).sqrt();
            let ring = 0.5 - ((distance - 14.5).abs() - 1.6);
            let dot = 0.5 - (distance - 5.0);
            let alpha = ring.max(dot).clamp(0.0, 1.0);
            pixels[(y * SIZE + x) * 4 + 3] = (alpha * 255.0) as u8;
        }
    }
    tauri::image::Image::new_owned(pixels, SIZE as u32, SIZE as u32)
}

/// The servers without a window, for the tests: prints where they listen.
fn headless() {
    let data_dir = std::env::var_os("LENS_DATA").map(Into::into).unwrap_or_else(|| std::env::temp_dir().join("lens"));
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    runtime.block_on(async {
        // Never OBS, unless asked: a test must not touch the scenes of an OBS that
        // happens to be open.
        let started =
            server::start(data_dir, std::env::var_os("LENS_OBS").is_some()).await.expect("Lens could not start");
        println!(
            "{}",
            serde_json::json!({
                "local": format!("http://127.0.0.1:{}", started.local_port),
                "phone": format!("https://127.0.0.1:{}/?t={}", started.phone_port, started.token),
            })
        );
        std::future::pending::<()>().await
    });
}
