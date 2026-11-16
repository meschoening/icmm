//! `run_marks.json` in the app's config folder, beside the preferences: what
//! this computer remembers of each platform's runs (#236). Whether the
//! platform has had a run, so First launch gives way to Home while it isn't
//! connected; and the last change of its runs database whose ended runs have
//! notified, so a reconnect notifies those that ended while ICMM was away.
//! A file that can't be read is nothing remembered, and the next mark
//! replaces it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::wire::types::{FeedPosition, InternalData, MarkRunsParams, RunMarks, WireError};

pub const FILE: &str = "run_marks.json";

/// One mark at a time, so two marks can't each read the file and lose the other's.
static WRITE: Mutex<()> = Mutex::new(());

/// What a platform's entry holds; unknown fields are kept out of it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Entry {
    #[serde(default)]
    first_run: bool,
    #[serde(default)]
    ended_seen: Option<FeedPosition>,
}

impl Entry {
    fn key(&self) -> (bool, Option<(&str, i64)>) {
        let seen = self.ended_seen.as_ref().map(|s| (s.feed.as_str(), s.seq));
        (self.first_run, seen)
    }
}

/// The marks, in the app's config folder.
pub fn stored(app: &tauri::AppHandle) -> Store {
    match app.path().app_config_dir() {
        Ok(dir) => Store::new(&dir),
        Err(e) => {
            let fallback = std::env::temp_dir().join("icmm");
            tracing::error!(
                "no config folder ({e}); keeping run marks in {}",
                fallback.display()
            );
            Store::new(&fallback)
        }
    }
}

/// The marks in `dir`.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Store {
        Store {
            path: dir.join(FILE),
        }
    }

    fn entries(&self) -> BTreeMap<String, Entry> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
            Err(e) => {
                tracing::error!("couldn't read {}: {e}", self.path.display());
                return BTreeMap::new();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::error!("couldn't read {}: {e}", self.path.display());
            BTreeMap::new()
        })
    }

    /// What's remembered of platform `id`'s runs; nothing for one not seen.
    pub fn load(&self, id: &str) -> RunMarks {
        let entry = self.entries().remove(id).unwrap_or_default();
        RunMarks {
            first_run: entry.first_run,
            ended_seen: entry.ended_seen,
        }
    }

    /// Adds `marks` to what's remembered of its platform: a first run once
    /// marked stays marked, and a position replaces the one before.
    pub fn mark(&self, marks: &MarkRunsParams) -> Result<(), WireError> {
        let _write = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries();
        let entry = entries.entry(marks.platform_id.clone()).or_default();
        let before = entry.clone();
        entry.first_run |= marks.first_run;
        if let Some(seen) = &marks.ended_seen {
            entry.ended_seen = Some(seen.clone());
        }
        if entry.key() == before.key() && self.path.exists() {
            return Ok(());
        }
        self.write(&entries).map_err(|e| {
            let message = format!(
                "Couldn’t save what ICMM remembers of this platform’s runs to {}: {e}.",
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

    /// Writes beside the file and renames into place, so a crash never leaves
    /// half a file.
    fn write(&self, entries: &BTreeMap<String, Entry>) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut text = serde_json::to_string_pretty(entries).map_err(std::io::Error::other)?;
        text.push('\n');
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, &self.path)
    }

    /// Deletes the file, so nothing is remembered.
    pub fn forget(&self) -> std::io::Result<()> {
        let _write = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(std::io::Error::new(
                e.kind(),
                format!("{}: {e}", self.path.display()),
            )),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(position: Option<FeedPosition>) -> Option<(String, i64)> {
        position.map(|p| (p.feed, p.seq))
    }

    fn seen(seq: i64) -> FeedPosition {
        FeedPosition {
            feed: "6f1c2a9e4b7d4e0f".into(),
            seq,
        }
    }

    fn mark(id: &str, first_run: bool, ended_seen: Option<FeedPosition>) -> MarkRunsParams {
        MarkRunsParams {
            platform_id: id.into(),
            first_run,
            ended_seen,
        }
    }

    #[test]
    fn a_platform_never_marked_has_had_no_run_and_seen_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let marks = Store::new(dir.path()).load("p1");
        assert!(!marks.first_run);
        assert_eq!(at(marks.ended_seen), None);
    }

    #[test]
    fn marks_add_to_what_a_platform_has_and_leave_the_others_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(&dir.path().join("new folder"));
        store.mark(&mark("p1", true, None)).unwrap();
        store.mark(&mark("p1", false, Some(seen(4812)))).unwrap();
        store.mark(&mark("p2", false, Some(seen(7)))).unwrap();

        let p1 = store.load("p1");
        assert!(p1.first_run, "a first run stays marked");
        assert_eq!(at(p1.ended_seen), at(Some(seen(4812))));
        let p2 = store.load("p2");
        assert!(!p2.first_run);
        assert_eq!(at(p2.ended_seen), at(Some(seen(7))));
    }

    #[test]
    fn a_file_that_cant_be_read_is_nothing_and_the_next_mark_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "{\"p1\": [").unwrap();
        let store = Store::new(dir.path());
        assert!(!store.load("p1").first_run);
        store.mark(&mark("p1", true, None)).unwrap();
        assert!(store.load("p1").first_run);
    }

    #[test]
    fn forgetting_leaves_nothing_and_forgetting_again_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        store.mark(&mark("p1", true, Some(seen(3)))).unwrap();
        store.forget().unwrap();
        store.forget().unwrap();
        assert_eq!(at(store.load("p1").ended_seen), None);
    }
}
