//! Show in Finder for a run's log on This computer (#289). The log view
//! names the file a log read gave it; this shows only a file named as a
//! run's logs are, in its run's folder in an Output folder
//! (`icmm.coordinator.files`), so the page can't open any other.

use std::path::{Component, Path};

/// Whether `path` is named as one of a run's logs: a try's Start log
/// (`run-214-1f3a9c0e/T12.3/start-71-try-1.ndjson`), an array task's job
/// log on SLURM (`…/arrays/5-71.out`) or This computer
/// (`…/local-12_71.out`), or a generation's coordinating job log
/// (`…/coordinator-9.log`).
pub fn is_run_log(path: &Path) -> bool {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let names: Vec<&str> = path
        .components()
        .rev()
        .take(3)
        .map(|c| c.as_os_str().to_str().unwrap_or(""))
        .collect();
    let [file, parent, grandparent] = names[..] else {
        return false;
    };
    if let Some(stem) = file.strip_suffix(".ndjson") {
        return start_log(stem) && topology(parent) && run_folder(grandparent);
    }
    if let Some(stem) = file.strip_suffix(".out") {
        if parent == "arrays" {
            return pair(stem, '-') && run_folder(grandparent);
        }
        return stem
            .strip_prefix("local-")
            .and_then(|s| s.rsplit_once('_'))
            .is_some_and(|(job, task)| !job.is_empty() && number(task))
            && run_folder(parent);
    }
    file.strip_prefix("coordinator-")
        .and_then(|s| s.strip_suffix(".log"))
        .is_some_and(number)
        && run_folder(parent)
}

/// `run-214-1f3a9c0e`: the run's number and its runs database's id.
fn run_folder(name: &str) -> bool {
    name.strip_prefix("run-")
        .and_then(|s| s.split_once('-'))
        .is_some_and(|(run, feed)| {
            number(run) && feed.len() == 8 && feed.bytes().all(|b| b.is_ascii_hexdigit())
        })
}

/// `T12.3`.
fn topology(name: &str) -> bool {
    name.strip_prefix('T').is_some_and(|s| pair(s, '.'))
}

/// `start-71-try-1`.
fn start_log(stem: &str) -> bool {
    stem.strip_prefix("start-")
        .and_then(|s| s.split_once("-try-"))
        .is_some_and(|(start, attempt)| number(start) && number(attempt))
}

fn pair(s: &str, by: char) -> bool {
    s.split_once(by)
        .is_some_and(|(a, b)| number(a) && number(b))
}

fn number(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// An Output folder, absolute on every OS.
    fn output() -> PathBuf {
        std::env::temp_dir().join("icmm").join("output")
    }

    #[test]
    fn each_of_a_runs_logs_is_one() {
        let run = output().join("run-214-1f3a9c0e");
        for log in [
            "T12.3/start-71-try-1.ndjson",
            "arrays/5-71.out",
            "local-12_71.out",
            "local-48213:1761837062_0.out",
            "coordinator-9.log",
        ] {
            assert!(is_run_log(&run.join(log)), "{log}");
        }
    }

    #[test]
    fn any_other_file_is_not() {
        let run = output().join("run-214-1f3a9c0e");
        for path in [
            run.join("T12.3/start-71-try-1.json"),
            run.join("T12.3/start-71-try-1.live.json"),
            run.join("arrays/5.json"),
            run.join("arrays/5-71.out.sh"),
            run.join("coordinator-x.log"),
            run.join("T12/start-71-try-1.ndjson"),
            output().join("run-214/coordinator-9.log"),
            output().join("run-214-1f3a9c0g/coordinator-9.log"),
            output().join(".ssh/id_ed25519"),
            run.join("../run-214-1f3a9c0e/coordinator-9.log"),
            PathBuf::from("run-214-1f3a9c0e/coordinator-9.log"),
        ] {
            assert!(!is_run_log(&path), "{}", path.display());
        }
    }
}
