//! The window's size and place: kept by the window-state plugin, which opens
//! it where it was left, and forgotten by Reset.

use tauri::{LogicalSize, Manager};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// What the plugin keeps. Not whether the window is shown: ICMM always opens
/// it.
pub fn kept() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(kept())
        .build()
}

/// Puts the window back at its first launch's size, centered, as if just
/// installed. The plugin saves where the window is when ICMM quits, so that
/// is what the next launch finds; the file goes now, in case ICMM never
/// quits cleanly.
pub async fn forget(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let first = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .map(|w| LogicalSize::new(w.width, w.height))
        .ok_or("the window isn't configured")?;
    // Leaving full screen animates on macOS, then restores the frame from
    // before it, so a size set meanwhile is lost: wait for it to end.
    if window.is_fullscreen().unwrap_or(false) {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if !window.is_fullscreen().unwrap_or(false) {
                break;
            }
        }
    }
    let reset = || -> tauri::Result<()> {
        window.unmaximize()?;
        window.set_size(first)?;
        window.center()
    };
    reset().map_err(|e| e.to_string())?;
    let file = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join(app.filename()))
        .map_err(|e| e.to_string())?;
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("{}: {e}", file.display()))
        }
        _ => Ok(()),
    }
}
