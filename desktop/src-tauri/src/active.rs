//! The app's saved platforms and its one connection, to the Active platform
//! (ADR-0001): started at launch, published to the webview as
//! `connection_state` events, and asked by every generated agent command.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Emitter, Manager};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

use crate::agent::CallError;
use crate::connection::LineSink;
use crate::connection::platform::Platform;
use crate::connection::policy::Kind;
use crate::engine::host::HostEngine;
use crate::engine::{Engine, Engines, host_target};
use crate::platforms::store::{Saved, THIS_COMPUTER, expand_home};
use crate::platforms::{OnChanges, OnEvent, OnState, Platforms, RealConnector};

/// The event each new connection state is sent as; `connection_state` answers
/// with the latest.
pub const EVENT: &str = "connection_state";
/// The event each change in the Active platform's runs database is sent as:
/// its `Changes`, for the page to read again what they touch.
pub const CHANGES_EVENT: &str = "agent_changes";
/// The event each event of a page's own subscription, such as `watch_start`'s,
/// is sent as: `{subscription, event}`.
pub const AGENT_EVENT: &str = "agent_event";

static PLATFORMS: OnceLock<Arc<Platforms>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static HOST_ENGINE: OnceLock<Arc<HostEngine>> = OnceLock::new();

/// Loads the saved platforms and reconnects to the Active one.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let config = app.path().app_config_dir().unwrap_or_else(|e| {
        let fallback = std::env::temp_dir().join("icmm");
        tracing::error!(
            "no config folder ({e}); keeping platforms in {}",
            fallback.display()
        );
        fallback
    });
    let on_state: OnState = {
        let app = app.clone();
        Box::new(move |state| {
            if let Err(e) = app.emit(EVENT, state) {
                tracing::warn!("couldn't send the connection state to the page: {e}");
            }
        })
    };
    let on_changes: OnChanges = {
        let app = app.clone();
        Box::new(move |changes| {
            if let Err(e) = app.emit(CHANGES_EVENT, changes) {
                tracing::warn!("couldn't send the platform's changes to the page: {e}");
            }
        })
    };
    let on_event: OnEvent = {
        let app = app.clone();
        Box::new(move |pushed| {
            if let Err(e) = app.emit(AGENT_EVENT, pushed) {
                tracing::warn!("couldn't send a watch's event to the page: {e}");
            }
        })
    };
    // Found once, off the connect's path: a connect says it's connecting first.
    let engines = engines(app);
    engines.preload();
    start_host_engine(app, &engines);
    let saved = Saved::load(&config);
    // This computer's stopped runs restart whatever the Active platform. The
    // launch smoke quits as its page loads, so it starts none.
    if !crate::smoke::running()
        && let Some(Platform::Local { data_folder, .. }) = saved.target(THIS_COMPUTER)
    {
        crate::recover::start(&engines, expand_home(&data_folder));
    }
    let connector = RealConnector {
        app_version: app.package_info().version.to_string(),
        engines,
        agent_log: Arc::from(agent_log(app.path().app_log_dir().ok().as_deref())),
    };
    let platforms = Platforms::new(saved, Box::new(connector), on_state, on_changes, on_event);
    if PLATFORMS.set(platforms.clone()).is_err() {
        return tracing::error!("the platforms were started twice");
    }
    // The launch smoke connects to no saved platform.
    if !crate::smoke::running() {
        tauri::async_runtime::spawn(async move { platforms.launch().await });
    }
}

/// Makes the host engine, in `engine/` in the app's own data folder, and
/// installs it there from launch when it's missing, so the first call seldom
/// waits for that. The launch smoke quits as its page loads, which would cut
/// the install short in the user's own folder, so it installs nothing.
fn start_host_engine(app: &AppHandle, engines: &Engines) {
    let root = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|e| {
            let fallback = std::env::temp_dir().join("icmm");
            tracing::error!(
                "no data folder for the app ({e}); keeping its engine in {}",
                fallback.display()
            );
            fallback
        })
        .join(crate::engine::FOLDER);
    let host = Arc::new(HostEngine::new(
        Engine::Find(engines.clone(), host_target()),
        root,
    ));
    if HOST_ENGINE.set(host.clone()).is_err() {
        return tracing::error!("the host engine was made twice");
    }
    if !crate::smoke::running() {
        tauri::async_runtime::spawn(async move { host.prepare().await });
    }
}

/// The engine bundles this app carries: its `engines` resources, which
/// `scripts/engine_bundle.py` fills, unless `ICMM_ENGINES` names a folder.
pub fn engines(app: &AppHandle) -> Engines {
    if let Some(dir) = std::env::var_os("ICMM_ENGINES") {
        return Engines::new(vec![dir.into()]);
    }
    let resources = app.path().resource_dir().map(|d| d.join("engines"));
    Engines::new(resources.into_iter().collect())
}

/// This computer's own engine, for the computation a login node mustn't do.
pub fn host_engine() -> &'static HostEngine {
    HOST_ENGINE
        .get()
        .expect("started in setup, before any command")
}

/// The app's saved platforms and connection.
pub fn platforms() -> &'static Arc<Platforms> {
    PLATFORMS
        .get()
        .expect("started in setup, before any command")
}

/// The running app, for the commands that open its dialogs.
pub fn app() -> &'static AppHandle {
    APP.get().expect("started in setup, before any command")
}

/// The running app, once setup has started it.
pub fn try_app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Calls an agent method on the Active platform: what every generated agent
/// command does.
pub async fn call<P: Serialize + Sync, R: DeserializeOwned>(
    method: &str,
    kind: Kind,
    params: Option<&P>,
    timeout: Duration,
) -> Result<R, CallError> {
    match PLATFORMS.get() {
        Some(platforms) => platforms.call(method, kind, params, timeout).await,
        None => Err(CallError::NotConnected),
    }
}

/// Writes the agent's stderr to a daily `agent.<date>.log` beside the app's
/// log, which prunes both to a week; with no log folder, to the app log.
fn agent_log(dir: Option<&Path>) -> Box<LineSink> {
    let appender = dir.and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix("agent")
            .filename_suffix("log")
            .build(dir)
            .ok()
    });
    match appender {
        Some(appender) => {
            let appender = Mutex::new(appender);
            Box::new(move |line: &[u8]| {
                use std::io::Write;
                let mut file = appender.lock().unwrap();
                let _ = file.write_all(line).and_then(|()| file.write_all(b"\n"));
            })
        }
        None => Box::new(
            |line: &[u8]| tracing::info!(target: "icmm_desktop::agent", "{}", String::from_utf8_lossy(line)),
        ),
    }
}
