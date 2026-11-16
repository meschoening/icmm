//! The right-click menus' Cut, Copy, Paste and Select All on Linux (#335).
//!
//! On macOS and Windows the page builds them from muda's predefined items, which act on their own.
//! On GTK those do nothing: muda fakes their keys through libxdo, a feature it can't use under
//! Wayland. So on Linux the page (`src/shell/systemMenus.ts`) builds plain items with these ids,
//! and each runs WebKitGTK's own editing command on the page, which keeps WebKit's undo and never
//! reads the clipboard into the page.

use tauri::{AppHandle, Runtime};

/// Runs the editing command of the right-click menu item `id` names, if it names one.
pub fn run<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(command) = command(id) else { return };
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let ran = window.with_webview(move |webview| {
            use webkit2gtk::WebViewExt;
            webview.inner().execute_editing_command(command);
        });
        if let Err(e) = ran {
            tracing::warn!(error = %e, "couldn't run the right-click menu's {command}");
        }
    }
    // macOS's and Windows' items are muda's predefined ones, which act on their own.
    #[cfg(not(target_os = "linux"))]
    let _ = (app, command);
}

/// The WebKitGTK editing command a right-click menu item runs, by the item's id.
fn command(id: &str) -> Option<&'static str> {
    match id {
        "edit-cut" => Some("Cut"),
        "edit-copy" => Some("Copy"),
        "edit-paste" => Some("Paste"),
        "edit-select-all" => Some("SelectAll"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::command;

    #[test]
    fn each_items_id_names_webkitgtks_editing_command() {
        assert_eq!(command("edit-cut"), Some("Cut"));
        assert_eq!(command("edit-copy"), Some("Copy"));
        assert_eq!(command("edit-paste"), Some("Paste"));
        assert_eq!(command("edit-select-all"), Some("SelectAll"));
    }

    #[test]
    fn other_menu_events_are_not_edits() {
        assert_eq!(command("quit"), None);
        assert_eq!(command(""), None);
    }
}
