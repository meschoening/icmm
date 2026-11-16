//! `preferences.json` in the app's config folder: this computer's theme,
//! notification and still-improving choices, how Results sorts its
//! leaderboard, and the starts whose Drift notice is dismissed. A file that can't be read gives
//! the defaults, and the next save replaces it; one saved before a preference
//! existed keeps its other choices.

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::wire::types::{
    InternalData, LeaderboardOrder, LeaderboardSort, Preferences, Theme, WireError,
};

pub const FILE: &str = "preferences.json";

/// What a new install starts with: the theme follows the system, runs that
/// end show a notification, no start is marked still improving, Results
/// sorts by the Val rank, and no Drift notice is dismissed.
pub fn defaults() -> Preferences {
    Preferences {
        theme: Theme::System,
        notifications: true,
        mark_still_improving: false,
        leaderboard: LeaderboardSort {
            order: LeaderboardOrder::Rank,
            descending: false,
        },
        drift_dismissed: Vec::new(),
    }
}

/// The app's preferences, in its config folder.
pub fn stored(app: &tauri::AppHandle) -> Store {
    match app.path().app_config_dir() {
        Ok(dir) => Store::new(&dir),
        Err(e) => {
            let fallback = std::env::temp_dir().join("icmm");
            tracing::error!(
                "no config folder ({e}); keeping preferences in {}",
                fallback.display()
            );
            Store::new(&fallback)
        }
    }
}

/// Gives the window `theme`, so its title bar matches the page and the
/// page's `prefers-color-scheme` follows it.
pub fn apply_theme(app: &tauri::AppHandle, theme: Theme) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let theme = match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    };
    if let Err(e) = window.set_theme(theme) {
        tracing::warn!("couldn't set the window's theme: {e}");
    }
}

/// The preferences in `dir`.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Store {
        Store {
            path: dir.join(FILE),
        }
    }

    pub fn load(&self) -> Preferences {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return defaults(),
            Err(e) => {
                tracing::error!("couldn't read {}: {e}", self.path.display());
                return defaults();
            }
        };
        // Each choice the file holds, over the defaults, so a preference added
        // since it was saved starts at its default.
        let read = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text)
            .and_then(|saved| {
                let mut all = serde_json::to_value(defaults())?;
                if let serde_json::Value::Object(all) = &mut all {
                    all.extend(saved);
                }
                serde_json::from_value(all)
            });
        read.unwrap_or_else(|e| {
            tracing::error!("couldn't read {}: {e}", self.path.display());
            defaults()
        })
    }

    /// Deletes the file, so the defaults load.
    pub fn forget(&self) -> std::io::Result<()> {
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(std::io::Error::new(
                e.kind(),
                format!("{}: {e}", self.path.display()),
            )),
            _ => Ok(()),
        }
    }

    /// Writes beside the file and renames into place, so a crash never leaves
    /// half a file.
    pub fn save(&self, preferences: &Preferences) -> Result<(), WireError> {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut text =
                serde_json::to_string_pretty(preferences).map_err(std::io::Error::other)?;
            text.push('\n');
            let temporary = self.path.with_extension("json.tmp");
            std::fs::write(&temporary, text)?;
            std::fs::rename(&temporary, &self.path)
        };
        write().map_err(|e| {
            let message = format!(
                "Couldn’t save the preferences to {}: {e}.",
                self.path.display()
            );
            tracing::error!("{message}");
            WireError::Internal {
                message,
                data: InternalData {
                    log_ref: "app.log".into(),
                },
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::types::DriftDismissal;

    #[test]
    fn with_nothing_saved_the_theme_follows_the_system_and_notifications_are_on() {
        let dir = tempfile::tempdir().unwrap();
        let preferences = Store::new(dir.path()).load();
        assert_eq!(preferences.theme, Theme::System);
        assert!(preferences.notifications);
        assert!(!preferences.mark_still_improving);
    }

    #[test]
    fn a_file_that_cant_be_read_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "{\"theme\": \"sepia\"").unwrap();
        let preferences = Store::new(dir.path()).load();
        assert_eq!(preferences.theme, Theme::System);
        assert!(preferences.notifications);
    }

    #[test]
    fn a_file_saved_before_a_preference_existed_keeps_its_choices_and_the_new_ones_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE),
            "{\"theme\": \"dark\", \"notifications\": false}",
        )
        .unwrap();
        let preferences = Store::new(dir.path()).load();
        assert_eq!(preferences.theme, Theme::Dark);
        assert!(!preferences.notifications);
        assert!(!preferences.mark_still_improving);
        assert_eq!(preferences.leaderboard.order, LeaderboardOrder::Rank);
        assert!(!preferences.leaderboard.descending);
        assert!(preferences.drift_dismissed.is_empty());
    }

    #[test]
    fn what_is_saved_is_what_loads() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(&dir.path().join("new folder"));
        let chosen = Preferences {
            theme: Theme::Dark,
            notifications: false,
            mark_still_improving: true,
            leaderboard: LeaderboardSort {
                order: LeaderboardOrder::NearBest,
                descending: true,
            },
            drift_dismissed: vec![DriftDismissal {
                platform_id: "p7k2m9xq4c".into(),
                run: 214,
                graph: 12,
                open_state: 3,
                start: 23,
                engine: Some("1.3.0-macos-arm64-ba9876543210".into()),
            }],
        };
        store.save(&chosen).unwrap();
        let loaded = Store::new(&dir.path().join("new folder")).load();
        assert_eq!(loaded.theme, Theme::Dark);
        assert!(!loaded.notifications);
        assert!(loaded.mark_still_improving);
        assert_eq!(loaded.leaderboard.order, LeaderboardOrder::NearBest);
        assert!(loaded.leaderboard.descending);
        assert_eq!(loaded.drift_dismissed.len(), 1);
        assert_eq!(loaded.drift_dismissed[0].start, 23);
        assert_eq!(
            loaded.drift_dismissed[0].engine.as_deref(),
            Some("1.3.0-macos-arm64-ba9876543210")
        );
    }

    #[test]
    fn forgotten_preferences_are_the_defaults_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        store
            .save(&Preferences {
                theme: Theme::Light,
                notifications: false,
                mark_still_improving: true,
                leaderboard: LeaderboardSort {
                    order: LeaderboardOrder::Train,
                    descending: true,
                },
                drift_dismissed: vec![DriftDismissal {
                    platform_id: "local".into(),
                    run: 7,
                    graph: 2,
                    open_state: 0,
                    start: 4,
                    engine: None,
                }],
            })
            .unwrap();
        store.forget().unwrap();
        store.forget().unwrap();
        let preferences = store.load();
        assert_eq!(preferences.theme, Theme::System);
        assert!(preferences.notifications);
        assert!(!preferences.mark_still_improving);
        assert_eq!(preferences.leaderboard.order, LeaderboardOrder::Rank);
        assert!(preferences.drift_dismissed.is_empty());
    }
}
