//! A failed connect in plain words ("The connection's failures and sentences
//! in plain words", #116): what happened, naming the platform and the
//! folder; the next step, worded so it says whose move it is (an
//! instruction is the user's, "Ask your cluster's admins…" is theirs, and
//! "That's a problem in ICMM" is ICMM's); and the raw line behind it, which
//! the strip sets in small mono. With them go the ways forward beside Retry
//! now, and whether Retry now can help at all.

use crate::engine::BundleError;
use crate::wire::types::ConnectFix;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Said {
    /// What happened.
    pub reason: String,
    /// The next step.
    pub next_step: String,
    /// The raw line: a host and port, a path, what a command or the engine said.
    pub details: Option<String>,
    pub fixes: Vec<ConnectFix>,
    /// Whether trying again can help, so Retry now shows.
    pub can_retry: bool,
}

impl Said {
    /// A failure trying again can help with, with no other way forward yet.
    pub fn new(reason: impl Into<String>, next_step: impl Into<String>) -> Said {
        Said {
            reason: reason.into(),
            next_step: next_step.into(),
            details: None,
            fixes: Vec::new(),
            can_retry: true,
        }
    }

    /// The raw line behind it; an empty one is none.
    pub fn details(self, details: impl Into<String>) -> Said {
        let details = details.into();
        let details = details.trim();
        Said {
            details: (!details.is_empty()).then(|| details.to_owned()),
            ..self
        }
    }

    /// Another way forward, after the ones before it.
    pub fn fix(mut self, fix: ConnectFix) -> Said {
        self.fixes.push(fix);
        self
    }

    /// Trying again can't help, so Retry now doesn't show.
    pub fn no_retry(self) -> Said {
        Said {
            can_retry: false,
            ..self
        }
    }
}

/// The start of a next step for a failure on the way to the platform.
pub const ONLINE: &str = "Check that this computer is online";
/// ICMM's own problem: a next step starts with it.
pub const ICMM: &str = "That’s a problem in ICMM, not something you did.";
/// How ICMM's problems end: Report a problem… beside it saves a report (#126).
pub const REPORT: &str = "report it";

/// ICMM's own problem, which a retry may get past.
pub fn icmm_retry_once() -> String {
    format!("{ICMM} Retry once; if it fails again, {REPORT}.")
}

/// A wait that ran out where the platform may be busy: the cluster, or this
/// computer.
pub fn busy(local: bool) -> &'static str {
    if local {
        "This computer may be busy. Retry in a minute."
    } else {
        "The cluster may be busy. Retry in a minute."
    }
}

/// Where a platform is, in a sentence: "on McKelvey HPC", or "on this
/// computer".
pub fn on(platform: &str, local: bool) -> String {
    if local {
        "on this computer".into()
    } else {
        format!("on {platform}")
    }
}

/// `name` in `folder`, with the separator the folder is written with:
/// `~/icmm/runs.db`, or `D:\icmm\runs.db` for a Windows folder outside the
/// home folder.
pub fn within(folder: &str, name: &str) -> String {
    let windows = folder.contains('\\') && !folder.contains('/');
    let sep = if windows { '\\' } else { '/' };
    format!("{}{sep}{name}", folder.trim_end_matches(['/', '\\']))
}

/// A byte count as people read it: "350 MB", "1.2 GB".
pub fn size(bytes: i64) -> String {
    let bytes = bytes.max(0) as f64;
    for (unit, scale) in [("GB", 1e9), ("MB", 1e6), ("kB", 1e3)] {
        if bytes >= scale {
            let n = bytes / scale;
            return if n >= 10.0 {
                format!("{n:.0} {unit}")
            } else {
                format!("{n:.1} {unit}")
            };
        }
    }
    format!("{bytes:.0} bytes")
}

/// This app can't have the engine `needs` ("McKelvey HPC", "this computer")
/// runs: it carries none, and retrying can't help, or looking stopped.
pub fn no_bundle(e: BundleError, needs: &str) -> Said {
    match e {
        BundleError::Missing(found) => Said::new(
            format!("This copy of ICMM is missing the engine {needs} needs."),
            format!(
                "That’s a problem in ICMM, not something you did, so retrying won’t help. \
                 Reinstall ICMM; if that doesn’t help, {REPORT}."
            ),
        )
        .details(found)
        .fix(ConnectFix::Report)
        .no_retry(),
        BundleError::Stopped(why) => {
            Said::new("ICMM couldn’t look for its engine.", icmm_retry_once())
                .details(why)
                .fix(ConnectFix::Report)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::within;

    #[test]
    fn a_file_in_a_folder_takes_the_folders_separator() {
        assert_eq!(within("~/icmm", "runs.db"), "~/icmm/runs.db");
        assert_eq!(within("/scratch/icmm/", "runs.db"), "/scratch/icmm/runs.db");
        assert_eq!(within(r"D:\icmm", "runs.db"), r"D:\icmm\runs.db");
    }
}
