//! The window's size and place: kept by the window-state plugin, which opens
//! it where it was left, fitted to the monitor's work area, and forgotten by
//! Reset.

use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize};
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

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The window resized and moved so all of it shows in the work area.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fitted {
    /// Its content's size, in physical pixels.
    pub inner: (u32, u32),
    /// Its frame's top left corner, in physical pixels.
    pub at: (i32, i32),
    /// Its least content size, in logical pixels: the configured one, or what
    /// the work area has room for.
    pub min: (f64, f64),
}

/// How the window fits in `work`, the monitor's work area (the screen less
/// the taskbar, the menu bar or the Dock), given its frame `outer`, its
/// content's size `inner`, the monitor's `scale` and the configured least
/// content size `min` in logical pixels; `None` where it fits already. A
/// 1280 × 800 Windows screen leaves 752 px above its taskbar, so an 800 px
/// window hid its bottom 48 px (#505).
pub fn fitted(
    work: Rect,
    outer: Rect,
    inner: (u32, u32),
    scale: f64,
    min: (f64, f64),
) -> Option<Fitted> {
    let frame = (
        outer.width.saturating_sub(inner.0),
        outer.height.saturating_sub(inner.1),
    );
    let room = (
        work.width.saturating_sub(frame.0),
        work.height.saturating_sub(frame.1),
    );
    let inner = (inner.0.min(room.0), inner.1.min(room.1));
    let min = (
        min.0.min((f64::from(room.0) / scale).floor()),
        min.1.min((f64::from(room.1) / scale).floor()),
    );
    let size = (inner.0 + frame.0, inner.1 + frame.1);
    let within = |at: i32, size: u32, from: i32, span: u32| {
        let last = from + (span - size.min(span)) as i32;
        at.clamp(from, last)
    };
    let at = (
        within(outer.x, size.0, work.x, work.width),
        within(outer.y, size.1, work.y, work.height),
    );
    let fits = (size.0, size.1) == (outer.width, outer.height) && at == (outer.x, outer.y);
    (!fits).then_some(Fitted { inner, at, min })
}

/// Fits the window to its monitor's work area, unless it is maximized or full
/// screen, which the OS fits itself.
pub fn fit(app: &tauri::AppHandle) {
    if let Err(e) = try_fit(app) {
        tracing::warn!("couldn't fit the window to the screen: {e}");
    }
}

fn try_fit(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let Some(min) =
        configured(app).map(|w| (w.min_width.unwrap_or(0.0), w.min_height.unwrap_or(0.0)))
    else {
        return Ok(());
    };
    let area = monitor.work_area();
    let work = Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let (position, size, inner) = (
        window.outer_position()?,
        window.outer_size()?,
        window.inner_size()?,
    );
    let outer = Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let Some(f) = fitted(
        work,
        outer,
        (inner.width, inner.height),
        monitor.scale_factor(),
        min,
    ) else {
        return Ok(());
    };
    tracing::info!("fitted the window to the screen's work area: {f:?}");
    // The least size first, or the OS keeps the window above it.
    window.set_min_size(Some(LogicalSize::new(f.min.0, f.min.1)))?;
    window.set_size(PhysicalSize::new(f.inner.0, f.inner.1))?;
    window.set_position(PhysicalPosition::new(f.at.0, f.at.1))
}

fn configured(app: &tauri::AppHandle) -> Option<&tauri::utils::config::WindowConfig> {
    app.config().app.windows.iter().find(|w| w.label == "main")
}

/// Puts the window back at its first launch's size, centered, as if just
/// installed. The plugin saves where the window is when ICMM quits, so that
/// is what the next launch finds; the file goes now, in case ICMM never
/// quits cleanly.
pub async fn forget(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let first = configured(app)
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
    fit(app);
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

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: (f64, f64) = (1200.0, 720.0);

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_window_taller_than_the_work_area_shrinks_above_the_taskbar() {
        // 1280 × 800 at 100 %, a 48 px taskbar; Windows' title bar is 31 px.
        let work = rect(0, 0, 1280, 752);
        let outer = rect(40, 0, 1200, 831);
        let f = fitted(work, outer, (1200, 800), 1.0, MIN).unwrap();
        assert_eq!(f.inner, (1200, 721));
        assert_eq!(f.at, (40, 0));
        assert_eq!(f.min, (1200.0, 720.0));
    }

    #[test]
    fn the_least_height_follows_a_shorter_work_area() {
        // 1366 × 768 at 125 %: a 1093 × 614 logical screen, a 40 px taskbar.
        let work = rect(0, 0, 1366, 718);
        let outer = rect(0, 0, 1366, 1039);
        let f = fitted(work, outer, (1366, 1000), 1.25, (1000.0, 720.0)).unwrap();
        assert_eq!(f.inner, (1366, 679));
        assert_eq!(f.min, (1000.0, 543.0));
        assert_eq!(f.at, (0, 0));
    }

    #[test]
    fn a_window_partly_below_the_work_area_moves_up_into_it() {
        let work = rect(0, 25, 1512, 920);
        let outer = rect(100, 300, 1200, 828);
        let f = fitted(work, outer, (1200, 800), 2.0, MIN).unwrap();
        assert_eq!(f.inner, (1200, 800));
        assert_eq!(f.at, (100, 117));
    }

    #[test]
    fn a_window_that_fits_stays_as_it_is() {
        let work = rect(-1920, 0, 1920, 1040);
        let outer = rect(-1800, 100, 1200, 828);
        assert_eq!(fitted(work, outer, (1200, 800), 1.0, MIN), None);
    }
}
