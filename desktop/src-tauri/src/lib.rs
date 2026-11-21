//! The ICMM desktop app.

pub mod active;
pub mod agent;
mod clock;
pub mod connection;
mod dataset_file;
mod desktop;
mod edit;
pub mod engine;
mod logging;
pub mod platforms;
pub mod preferences;
mod quit;
mod recently_opened;
pub mod recover;
mod report;
mod reset;
mod run_logs;
mod run_marks;
mod smoke;
mod webview;
mod window;
pub mod wire;
pub mod workbook;

use tauri::Manager;
use tauri::webview::PageLoadEvent;

/// With the smoke, it also fails unless it carries This computer's engine.
const REQUIRE_ENGINE_ENV: &str = "ICMM_REQUIRE_ENGINE";

pub fn run() {
    let context = tauri::generate_context!();
    let smoke = smoke::running();
    // Before Tauri reads or writes anything of the identity's.
    if smoke {
        if let Some(refusal) = smoke::refusal(context.config()) {
            eprintln!("{}: {refusal}", smoke::ENV);
            std::process::exit(2);
        }
        println!("{}", smoke::identity_line(&context.config().identifier));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(window::plugin())
        .setup(|app| {
            logging::init(app.path().app_log_dir().ok().as_deref());
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                os = std::env::consts::OS,
                arch = std::env::consts::ARCH,
                webview = %webview::version_or_unknown(),
                "ICMM started"
            );
            let theme = preferences::stored(app.handle()).load().theme;
            preferences::apply_theme(app.handle(), theme);
            // The plugin has put the window where it was left; on a first
            // launch, or on a smaller screen, it may hang off the work area.
            window::fit(app.handle());
            window::show_anyway_later(app.handle());
            active::start(app.handle());
            #[cfg(target_os = "macos")]
            quit::ask_on_terminate();
            Ok(())
        })
        .invoke_handler(wire::commands::wire_handler!())
        // The right-click menus' items on Linux (`edit`).
        .on_menu_event(|app, event| edit::run(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // Closing the window quits ICMM, so it asks as quitting does.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && quit::ask_first(window.app_handle())
            {
                api.prevent_close();
            }
        })
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                quit::GUARD.loaded();
            }
            if payload.event() == PageLoadEvent::Finished {
                // It opened hidden: it shows painted, not blank (#538).
                window::show(webview.app_handle());
            }
            if smoke && payload.event() == PageLoadEvent::Finished {
                println!("{}: loaded {}", smoke::ENV, payload.url());
                // The gate builds an engine bundle first, so the app must carry it.
                if std::env::var_os(REQUIRE_ENGINE_ENV).is_some() {
                    let engines = active::engines(webview.app_handle());
                    match engines.find(engine::host_target()) {
                        Ok(bundle) => println!("{}: carries engine {}", smoke::ENV, bundle.key),
                        Err(e) => {
                            eprintln!("{}: {e}", smoke::ENV);
                            std::process::exit(1);
                        }
                    }
                }
                // Not `AppHandle::exit`: on Windows without an interactive
                // desktop (the CI runner's service, an SSH session) the
                // graceful shutdown never finishes.
                std::process::exit(0);
            }
        })
        .run(context)
        .expect("error while running ICMM");
}
