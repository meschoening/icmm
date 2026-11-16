//! `recently_opened.json` in the app's config folder, beside `run_marks.json`:
//! the pages last opened on each saved platform, for ⌘K's Recently opened
//! (#411). Newest first, at most 5, each page once. Reset deletes the file and
//! removing a platform forgets its own. A file that can't be read is nothing
//! remembered, and the next page opened replaces it; an entry this ICMM can't
//! read is skipped, so the rest still show.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

use crate::wire::types::{InternalData, OpenedPage, RecentlyOpened, RecordOpenedParams, WireError};

pub const FILE: &str = "recently_opened.json";

/// How many pages a platform keeps.
pub const KEPT: usize = 5;

/// One change at a time, so two can't each read the file and lose the other's.
static WRITE: Mutex<()> = Mutex::new(());

type Entries = BTreeMap<String, Vec<serde_json::Value>>;

/// The pages, in the app's config folder.
pub fn stored(app: &tauri::AppHandle) -> Store {
    match app.path().app_config_dir() {
        Ok(dir) => Store::new(&dir),
        Err(e) => {
            let fallback = std::env::temp_dir().join("icmm");
            tracing::error!(
                "no config folder ({e}); keeping recently opened pages in {}",
                fallback.display()
            );
            Store::new(&fallback)
        }
    }
}

/// Whether `a` and `b` are the same page, whatever name each was opened under.
fn same(a: &OpenedPage, b: &OpenedPage) -> bool {
    use OpenedPage as P;
    match (a, b) {
        (P::Run { run: x, .. }, P::Run { run: y, .. }) => x == y,
        (
            P::Topology {
                run: r1,
                graph: g1,
                open_state: o1,
                ..
            },
            P::Topology {
                run: r2,
                graph: g2,
                open_state: o2,
                ..
            },
        ) => (r1, g1, o1) == (r2, g2, o2),
        (
            P::Start {
                run: r1,
                graph: g1,
                open_state: o1,
                start: s1,
                ..
            },
            P::Start {
                run: r2,
                graph: g2,
                open_state: o2,
                start: s2,
                ..
            },
        ) => (r1, g1, o1, s1) == (r2, g2, o2, s2),
        (P::Dataset { id: x, .. }, P::Dataset { id: y, .. })
        | (P::Config { id: x, .. }, P::Config { id: y, .. }) => x == y,
        _ => false,
    }
}

/// The pages in `dir`.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Store {
        Store {
            path: dir.join(FILE),
        }
    }

    fn entries(&self) -> Entries {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Entries::new(),
            Err(e) => {
                tracing::error!("couldn't read {}: {e}", self.path.display());
                return Entries::new();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::error!("couldn't read {}: {e}", self.path.display());
            Entries::new()
        })
    }

    fn pages(entries: &Entries, id: &str) -> Vec<OpenedPage> {
        entries
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .take(KEPT)
            .collect()
    }

    /// The pages last opened on platform `id`, newest first; none for one not seen.
    pub fn load(&self, id: &str) -> RecentlyOpened {
        RecentlyOpened {
            pages: Self::pages(&self.entries(), id),
        }
    }

    /// Puts `page` first on its platform, dropping an earlier opening of it and
    /// keeping [`KEPT`].
    pub fn record(&self, params: &RecordOpenedParams) -> Result<(), WireError> {
        let _write = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries();
        let mut pages = Self::pages(&entries, &params.platform_id);
        pages.retain(|p| !same(p, &params.page));
        pages.insert(0, params.page.clone());
        pages.truncate(KEPT);
        let values = pages
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(std::io::Error::other);
        let written = values.and_then(|values| {
            entries.insert(params.platform_id.clone(), values);
            self.write(&entries)
        });
        written.map_err(|e| {
            let message = format!(
                "Couldn’t save the pages ICMM remembers opening on this platform to {}: {e}.",
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

    /// Forgets platform `id`'s pages, as removing it does; the others stay.
    pub fn forget_platform(&self, id: &str) -> std::io::Result<()> {
        let _write = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries();
        if entries.remove(id).is_none() {
            return Ok(());
        }
        self.write(&entries)
    }

    /// Writes beside the file and renames into place, so a crash never leaves
    /// half a file.
    fn write(&self, entries: &Entries) -> std::io::Result<()> {
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

    fn run(run: i64, name: &str) -> OpenedPage {
        OpenedPage::Run {
            run,
            name: name.into(),
        }
    }

    fn dataset(id: &str, name: &str) -> OpenedPage {
        OpenedPage::Dataset {
            id: id.into(),
            name: name.into(),
        }
    }

    fn record(store: &Store, platform: &str, page: OpenedPage) {
        store
            .record(&RecordOpenedParams {
                platform_id: platform.into(),
                page,
            })
            .unwrap();
    }

    /// Each page as `kind:key name`, newest first.
    fn names(store: &Store, platform: &str) -> Vec<String> {
        store
            .load(platform)
            .pages
            .iter()
            .map(|p| match p {
                OpenedPage::Run { run, name } => format!("run:{run} {name}"),
                OpenedPage::Topology {
                    run,
                    graph,
                    open_state,
                    name,
                } => format!("topology:{run}/{graph}.{open_state} {name}"),
                OpenedPage::Start {
                    run,
                    graph,
                    open_state,
                    start,
                    name,
                } => format!("start:{run}/{graph}.{open_state}/{start} {name}"),
                OpenedPage::Dataset { id, name } => format!("dataset:{id} {name}"),
                OpenedPage::Config { id, name } => format!("config:{id} {name}"),
            })
            .collect()
    }

    #[test]
    fn a_platform_never_seen_has_opened_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Store::new(dir.path()).load("p1").pages.is_empty());
    }

    #[test]
    fn the_newest_goes_first_and_five_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(&dir.path().join("new folder"));
        for id in 1..=6 {
            record(&store, "p1", run(id, &format!("c{id}")));
        }
        assert_eq!(
            names(&store, "p1"),
            ["run:6 c6", "run:5 c5", "run:4 c4", "run:3 c3", "run:2 c2"]
        );
    }

    #[test]
    fn opening_a_page_again_moves_it_first_under_its_new_name() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        record(&store, "p1", run(214, "herg-wt-11state"));
        record(&store, "p1", dataset("ds1", "herg-wt"));
        record(&store, "p1", run(214, "herg-wt-11state-b"));
        assert_eq!(
            names(&store, "p1"),
            ["run:214 herg-wt-11state-b", "dataset:ds1 herg-wt"]
        );
    }

    #[test]
    fn pages_differ_by_kind_and_every_part_of_their_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let topology = |graph, open_state| OpenedPage::Topology {
            run: 214,
            graph,
            open_state,
            name: "c".into(),
        };
        let start = |start| OpenedPage::Start {
            run: 214,
            graph: 12,
            open_state: 3,
            start,
            name: "c".into(),
        };
        record(&store, "p1", topology(12, 3));
        record(&store, "p1", topology(12, 2));
        record(&store, "p1", start(37));
        record(&store, "p1", start(36));
        record(
            &store,
            "p1",
            OpenedPage::Config {
                id: "ds1".into(),
                name: "c".into(),
            },
        );
        record(&store, "p1", start(37));
        assert_eq!(
            names(&store, "p1"),
            [
                "start:214/12.3/37 c",
                "config:ds1 c",
                "start:214/12.3/36 c",
                "topology:214/12.2 c",
                "topology:214/12.3 c"
            ]
        );
    }

    #[test]
    fn each_platform_keeps_its_own_and_removing_one_forgets_only_its() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        record(&store, "p1", run(214, "a"));
        record(&store, "p2", run(41, "b"));
        store.forget_platform("p1").unwrap();
        store.forget_platform("p3").unwrap();
        assert!(names(&store, "p1").is_empty());
        assert_eq!(names(&store, "p2"), ["run:41 b"]);
    }

    #[test]
    fn a_file_that_cant_be_read_is_nothing_and_the_next_page_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "{\"p1\": [").unwrap();
        let store = Store::new(dir.path());
        assert!(names(&store, "p1").is_empty());
        record(&store, "p1", run(214, "a"));
        assert_eq!(names(&store, "p1"), ["run:214 a"]);
    }

    #[test]
    fn an_entry_this_icmm_cant_read_is_skipped_and_the_rest_show() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE),
            r#"{"p1": [{"kind": "notebook", "id": "n1", "name": "x"}, {"kind": "run", "run": 214, "name": "a"}]}"#,
        )
        .unwrap();
        let store = Store::new(dir.path());
        assert_eq!(names(&store, "p1"), ["run:214 a"]);
    }

    #[test]
    fn forgetting_leaves_nothing_and_forgetting_again_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        record(&store, "p1", run(214, "a"));
        store.forget().unwrap();
        store.forget().unwrap();
        assert!(names(&store, "p1").is_empty());
    }
}
