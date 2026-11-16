//! Which web engine the app is running in.
//!
//! WKWebView's user agent is frozen, so the page can't tell which WebKit it
//! has; the page asks here for the version and the OS, to log them beside
//! its CSS-support probe and to name them if the engine is too old
//! ("WebView support for the canvas's CSS", issue #11).

use crate::wire::types::WebviewInfo;

/// The engine's version and the OS it runs on.
pub fn webview_info() -> WebviewInfo {
    WebviewInfo {
        version: tauri::webview_version().ok(),
        os: std::env::consts::OS.to_owned(),
    }
}

/// The engine's version for the log, or `unknown`.
pub fn version_or_unknown() -> String {
    tauri::webview_version().unwrap_or_else(|_| "unknown".to_owned())
}
