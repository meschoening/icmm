//! The **Engine bundles** this app carries, one per kind of platform, and how
//! each gets onto its platform: into `<Data folder>/engine/<key>/` (ADR-0002,
//! ADR-0014), checked on every connect and installed when missing.
//!
//! `scripts/engine_bundle.py` builds each bundle and copies its archive into
//! `desktop/src-tauri/engines/`, the app's `engines` resources. A release
//! build refuses to build without the host's and the cluster's (`build.rs`).

mod bundle;
pub mod host;
pub mod local;
pub mod preflight;
pub mod remote;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use bundle::{Bundle, MANIFEST, Manifest};

use crate::wire::commands::PROTOCOL_VERSION;

/// Where a Data folder keeps its engines.
pub const FOLDER: &str = "engine";
/// What every SSH platform runs: a Linux cluster on x86_64.
pub const CLUSTER_TARGET: &str = "linux-x86_64";

/// The environment that makes an engine process's own waits `limit`: the
/// agent's idle exit, at most 10⁶ s since a longer queue wait overflows
/// Python's on Windows (`threading.TIMEOUT_MAX`, about 4.3 × 10⁶ s), and each
/// runs-database connection's busy wait, which SQLite takes in milliseconds
/// as a 32-bit int, so at most 2³¹ − 1.
pub fn env_waiting_up_to(limit: Duration) -> [(&'static str, String); 2] {
    let idle_s = limit.as_secs_f64().min(1e6);
    let busy_ms = limit.as_millis().min(i32::MAX as u128);
    [
        ("ICMM_AGENT_IDLE_TIMEOUT_S", idle_s.to_string()),
        ("ICMM_BUSY_TIMEOUT_MS", busy_ms.to_string()),
    ]
}

/// Why `icmm selfcheck` failed, from what it printed: the `error` of its
/// JSON line, else its last line.
pub fn selfcheck_error(output: &str) -> String {
    let last = output
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(last)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| last.to_owned())
}

/// The target this app runs on, as bundle keys spell it.
pub fn host_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", _) => "macos-x86_64",
        ("windows", _) => "windows-x86_64",
        _ => "linux-x86_64",
    }
}

/// Why a platform's bundle can't be had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleError {
    /// This app carries none for the target: what it found instead, as one
    /// raw line.
    Missing(String),
    /// Looking for it stopped.
    Stopped(String),
}

/// Finds the bundle for a target.
type Find = dyn Fn(&str) -> Result<Bundle, String> + Send + Sync;
/// A target's bundle once it's found, locked while it's looked for, so a
/// connect waits for the lookup launch started rather than starting another.
type Found = Arc<Mutex<Option<Bundle>>>;

/// The engine bundles this app carries. Finding one reads inside every
/// archive for its target, 0.3–0.4 s apiece (#105), so each target's is found
/// once, from launch (`preload`), and kept: the app's resources don't change
/// while it runs. A target with none is looked for again each time, so one
/// built since (in development) is found.
#[derive(Clone)]
pub struct Engines {
    find: Arc<Find>,
    found: Arc<Mutex<HashMap<String, Found>>>,
}

impl std::fmt::Debug for Engines {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Engines")
    }
}

impl Engines {
    /// The bundles in `dirs`.
    pub fn new(dirs: Vec<PathBuf>) -> Engines {
        Engines::from_fn(move |target| bundle::find(&dirs, target, PROTOCOL_VERSION))
    }

    /// The bundles `find` finds for each target.
    pub fn from_fn(
        find: impl Fn(&str) -> Result<Bundle, String> + Send + Sync + 'static,
    ) -> Engines {
        Engines {
            find: Arc::new(find),
            found: Arc::default(),
        }
    }

    /// Starts finding the bundles for this computer and for clusters, each on
    /// a thread of its own, so a connect seldom waits for them.
    pub fn preload(&self) {
        let mut targets = vec![host_target(), CLUSTER_TARGET];
        targets.dedup();
        for target in targets {
            let engines = self.clone();
            let started = std::thread::Builder::new()
                .name(format!("engines-{target}"))
                .spawn(move || engines.find(target));
            if let Err(e) = started {
                tracing::warn!("couldn't start looking for the {target} engine: {e}");
            }
        }
    }

    /// The bundle for `target` that speaks this app's protocol; the newest,
    /// when a build folder holds several. It blocks while it's looked for;
    /// once found, it answers at once.
    pub fn find(&self, target: &str) -> Result<Bundle, String> {
        let slot = self.slot(target);
        let mut found = slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(bundle) = found.as_ref() {
            return Ok(bundle.clone());
        }
        let bundle = (self.find)(target)?;
        *found = Some(bundle.clone());
        Ok(bundle)
    }

    fn slot(&self, target: &str) -> Found {
        let mut found = self.found.lock().unwrap_or_else(|e| e.into_inner());
        found.entry(target.to_owned()).or_default().clone()
    }

    /// `find`, on a blocking thread unless it's been found.
    pub async fn bundle(&self, target: &'static str) -> Result<Bundle, BundleError> {
        let found = self
            .slot(target)
            .try_lock()
            .ok()
            .and_then(|found| found.clone());
        if let Some(bundle) = found {
            return Ok(bundle);
        }
        let engines = self.clone();
        match tokio::task::spawn_blocking(move || engines.find(target)).await {
            Ok(found) => found.map_err(BundleError::Missing),
            Err(e) => Err(BundleError::Stopped(format!("{target}: {e}"))),
        }
    }
}

/// The engine a platform runs: a bundle, or the one `Engines` finds for its
/// target, looked up when a connect first needs it rather than before it
/// says it's connecting.
#[derive(Clone, Debug)]
pub enum Engine {
    Bundle(Box<Bundle>),
    Find(Engines, &'static str),
}

impl Engine {
    pub async fn bundle(&self) -> Result<Bundle, BundleError> {
        match self {
            Engine::Bundle(bundle) => Ok((**bundle).clone()),
            Engine::Find(engines, target) => engines.bundle(target).await,
        }
    }
}

impl From<Bundle> for Engine {
    fn from(bundle: Bundle) -> Engine {
        Engine::Bundle(Box::new(bundle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_limit_past_what_python_or_sqlite_can_wait_is_their_longest() {
        let year = Duration::from_secs(365 * 24 * 60 * 60);
        let env = |limit| env_waiting_up_to(limit).map(|(_, value)| value);

        assert_eq!(env(year), ["1000000", "2147483647"]);
        assert_eq!(env(Duration::from_millis(1500)), ["1.5", "1500"]);
    }
}
