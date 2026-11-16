//! Reset ICMM: what it does to the app's own files, and what it says when a
//! step fails.

use std::path::{Path, PathBuf};

/// The logs the app writes, each a daily `<prefix>.<date>.log`.
const PREFIXES: [&str; 2] = ["app", "agent"];

/// Deletes everything in the logs folder `dir`, except the newest log of each
/// kind, which the app is writing: those are emptied instead, so they go on
/// from nothing. Every entry is tried, and the ones that couldn't go are
/// named.
pub fn delete_logs(dir: &Path) -> Result<(), LogsFailure> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(LogsFailure {
                names: Vec::new(),
                in_use: false,
                first: e.to_string(),
            });
        }
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    // The app's logs before the agent's, as Reset's list names them.
    paths.sort_by_key(|p| (kind(p).unwrap_or(PREFIXES.len()), p.clone()));
    let written: Vec<&PathBuf> = PREFIXES
        .iter()
        .filter_map(|prefix| paths.iter().filter(|p| is_log(p, prefix)).max())
        .collect();
    let mut failure: Option<LogsFailure> = None;
    for path in &paths {
        let result = if written.contains(&path) {
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|file| file.set_len(0))
        } else if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        match result {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!("couldn't delete {}: {e}", path.display());
                let failure = failure.get_or_insert_with(|| LogsFailure {
                    names: Vec::new(),
                    in_use: true,
                    first: e.to_string(),
                });
                failure.names.push(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                );
                failure.in_use &= in_use(&e);
            }
        }
    }
    failure.map_or(Ok(()), Err)
}

/// Which of the app's logs `path` is, as an index into `PREFIXES`.
fn kind(path: &Path) -> Option<usize> {
    PREFIXES.iter().position(|prefix| is_log(path, prefix))
}

fn is_log(path: &Path, prefix: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(&format!("{prefix}.")) && n.ends_with(".log"))
}

/// Whether another program holding the file open is why it couldn't go:
/// Windows' sharing and lock violations. Elsewhere an open file can be
/// deleted.
fn in_use(error: &std::io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

/// Logs that couldn't be deleted.
#[derive(Debug, PartialEq, Eq)]
pub struct LogsFailure {
    /// Their file names, the app's first; none when the folder couldn't be
    /// read.
    pub names: Vec<String>,
    /// Whether every one of them was held open by another program.
    pub in_use: bool,
    /// Why the first couldn't go.
    pub first: String,
}

/// Deletes ICMM's key at `file` and its public half beside it, for a Reset
/// before the computer goes to someone else. A key already gone is deleted.
/// Only the key itself can fail the step: the public half lets no one in.
pub fn delete_icmm_key(file: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut public = file.as_os_str().to_owned();
    public.push(".pub");
    match std::fs::remove_file(&public) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!("couldn't delete {}: {e}", Path::new(&public).display());
        }
        _ => {}
    }
    Ok(())
}

/// Reset's steps after the logs, in the order they run. ICMM's key goes
/// only when the user asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Key,
    Platforms,
    Preferences,
    Window,
}

impl Step {
    /// What the step deletes or forgets, as Reset's list names it.
    fn what(self) -> &'static str {
        match self {
            Step::Key => "ICMM’s SSH key",
            Step::Platforms => "your saved platforms",
            Step::Preferences => "your theme and notification choices",
            Step::Window => "the window’s size and place",
        }
    }

    /// What it does: deletes the key, or forgets the rest.
    fn verb(self) -> (&'static str, &'static str) {
        match self {
            Step::Key => ("delete", "deleted"),
            _ => ("forget", "forgot"),
        }
    }
}

/// What Reset says when the logs couldn't all be deleted, naming them. They
/// go first, so nothing else was reset.
pub fn logs_unfinished(failure: &LogsFailure) -> String {
    if failure.names.is_empty() {
        return format!(
            "ICMM couldn’t read its logs folder: {}. Nothing else was reset.",
            sentence(&failure.first)
        );
    }
    let files = named(&failure.names);
    if failure.in_use {
        let them = if failure.names.len() == 1 {
            "it"
        } else {
            "them"
        };
        format!(
            "ICMM couldn’t delete {files} in its logs folder, because another app has {them} \
             open. Nothing else was reset. Close that app, then try again."
        )
    } else {
        format!(
            "ICMM couldn’t delete {files} in its logs folder: {}. Nothing else was reset.",
            sentence(&failure.first)
        )
    }
}

/// Up to three names, or two and how many more.
fn named(names: &[String]) -> String {
    match names {
        [a, b, _, _, ..] => format!("{a}, {b} and {} more", names.len() - 2),
        _ => listed(names),
    }
}

/// What Reset says when `failed`, one of the `steps` it ran after the logs,
/// didn't finish: what it did, and what's left.
pub fn unfinished(steps: &[Step], failed: Step, error: &str) -> String {
    let at = steps.iter().position(|s| *s == failed).expect("a step");
    let mut done = vec!["deleted its logs".to_owned()];
    done.extend(
        steps[..at]
            .iter()
            .map(|s| format!("{} {}", s.verb().1, s.what())),
    );
    let left: Vec<&str> = steps[at + 1..].iter().map(|s| s.what()).collect();
    let mut said = format!(
        "ICMM {}, but couldn’t {} {}: {}.",
        listed(&done),
        failed.verb().0,
        failed.what(),
        sentence(error)
    );
    if !left.is_empty() {
        let left = listed(&left);
        let mut first = left.chars();
        let left: String = first
            .next()
            .map(|c| c.to_uppercase().chain(first).collect())
            .unwrap_or_default();
        said.push_str(&format!(" {left} are left as they were."));
    }
    said
}

/// `a`, `a and b`, `a, b and c`.
fn listed(items: &[impl AsRef<str>]) -> String {
    match items {
        [] => String::new(),
        [one] => one.as_ref().to_owned(),
        [rest @ .., last] => {
            let rest: Vec<&str> = rest.iter().map(AsRef::as_ref).collect();
            format!("{} and {}", rest.join(", "), last.as_ref())
        }
    }
}

/// An error to end a sentence with, without doubling its full stop.
fn sentence(error: &str) -> &str {
    error.trim_end().trim_end_matches('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn deletes_every_log_but_empties_the_ones_being_written() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path();
        for name in [
            "app.2026-09-28.log",
            "app.2026-10-04.log",
            "agent.2026-10-01.log",
            "agent.2026-10-03.log",
        ] {
            std::fs::write(logs.join(name), "a line\n").unwrap();
        }

        delete_logs(logs).unwrap();

        assert_eq!(names(logs), ["agent.2026-10-03.log", "app.2026-10-04.log"]);
        for name in names(logs) {
            assert_eq!(std::fs::read_to_string(logs.join(name)).unwrap(), "");
        }
    }

    #[cfg(unix)]
    #[test]
    fn logs_that_cant_be_deleted_are_named_and_left() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir(&logs).unwrap();
        for name in [
            "app.2026-10-02.log",
            "app.2026-10-04.log",
            "agent.2026-10-01.log",
            "agent.2026-10-04.log",
        ] {
            std::fs::write(logs.join(name), "a line\n").unwrap();
        }
        std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o555)).unwrap();

        let failure = delete_logs(&logs).unwrap_err();
        std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            failure.names,
            ["app.2026-10-02.log", "agent.2026-10-01.log"]
        );
        assert!(!failure.in_use);
        assert!(
            failure.first.contains("ermission denied"),
            "{}",
            failure.first
        );
        assert_eq!(names(&logs).len(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn a_log_another_program_holds_open_is_named_as_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path();
        for name in [
            "app.2026-10-02.log",
            "app.2026-10-04.log",
            "agent.2026-10-01.log",
        ] {
            std::fs::write(logs.join(name), "a line\n").unwrap();
        }
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(logs.join("app.2026-10-02.log"))
            .unwrap();

        let failure = delete_logs(logs).unwrap_err();

        assert_eq!(failure.names, ["app.2026-10-02.log"]);
        assert!(failure.in_use);
        assert_eq!(
            names(logs),
            [
                "agent.2026-10-01.log",
                "app.2026-10-02.log",
                "app.2026-10-04.log"
            ]
        );
    }

    #[test]
    fn a_missing_logs_folder_has_nothing_to_delete() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(delete_logs(&dir.path().join("logs")), Ok(()));
    }

    fn held(names: &[&str]) -> LogsFailure {
        LogsFailure {
            names: names.iter().map(|n| (*n).to_owned()).collect(),
            in_use: true,
            first: "The process cannot access the file because it is being used by another process. (os error 32)".into(),
        }
    }

    #[test]
    fn logs_another_program_holds_open_are_named_and_nothing_else_was_reset() {
        assert_eq!(
            logs_unfinished(&held(&["app.2026-10-03.log", "agent.2026-10-03.log"])),
            "ICMM couldn’t delete app.2026-10-03.log and agent.2026-10-03.log in its logs \
             folder, because another app has them open. Nothing else was reset. Close that app, \
             then try again."
        );
        assert_eq!(
            logs_unfinished(&held(&["agent.2026-10-03.log"])),
            "ICMM couldn’t delete agent.2026-10-03.log in its logs folder, because another app \
             has it open. Nothing else was reset. Close that app, then try again."
        );
    }

    #[test]
    fn three_logs_are_named_and_more_name_two_and_count_the_rest() {
        assert!(
            logs_unfinished(&held(&[
                "app.2026-10-01.log",
                "app.2026-10-02.log",
                "agent.2026-10-02.log"
            ]))
            .starts_with(
                "ICMM couldn’t delete app.2026-10-01.log, app.2026-10-02.log and \
                 agent.2026-10-02.log in its logs folder,"
            )
        );
        assert!(
            logs_unfinished(&held(&[
                "app.2026-10-01.log",
                "app.2026-10-02.log",
                "app.2026-10-03.log",
                "agent.2026-10-02.log",
                "agent.2026-10-03.log"
            ]))
            .starts_with(
                "ICMM couldn’t delete app.2026-10-01.log, app.2026-10-02.log and 3 more in its \
                 logs folder, because another app has them open."
            )
        );
    }

    #[test]
    fn a_log_that_couldnt_go_otherwise_says_why() {
        let failure = LogsFailure {
            names: vec!["app.2026-10-02.log".into()],
            in_use: false,
            first: "Permission denied (os error 13)".into(),
        };
        assert_eq!(
            logs_unfinished(&failure),
            "ICMM couldn’t delete app.2026-10-02.log in its logs folder: Permission denied (os \
             error 13). Nothing else was reset."
        );
    }

    #[test]
    fn a_logs_folder_that_cant_be_read_says_so() {
        let failure = LogsFailure {
            names: vec![],
            in_use: false,
            first: "Permission denied (os error 13)".into(),
        };
        assert_eq!(
            logs_unfinished(&failure),
            "ICMM couldn’t read its logs folder: Permission denied (os error 13). Nothing else \
             was reset."
        );
    }

    #[test]
    fn deleting_icmm_s_key_takes_its_public_half_and_leaves_the_users_keys() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path();
        for name in [
            "icmm_ed25519",
            "icmm_ed25519.pub",
            "id_ed25519",
            "id_ed25519.pub",
        ] {
            std::fs::write(ssh.join(name), "a key\n").unwrap();
        }

        delete_icmm_key(&ssh.join("icmm_ed25519")).unwrap();

        assert_eq!(names(ssh), ["id_ed25519", "id_ed25519.pub"]);
    }

    #[test]
    fn a_key_already_gone_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        assert!(delete_icmm_key(&dir.path().join("icmm_ed25519")).is_ok());
    }

    #[test]
    fn a_later_step_says_what_was_done_and_what_is_left() {
        let steps = [Step::Platforms, Step::Preferences, Step::Window];
        assert_eq!(
            unfinished(&steps, Step::Platforms, "Permission denied (os error 13)"),
            "ICMM deleted its logs, but couldn’t forget your saved platforms: Permission denied \
             (os error 13). Your theme and notification choices and the window’s size and place \
             are left as they were."
        );
        assert_eq!(
            unfinished(&steps, Step::Preferences, "Permission denied (os error 13)"),
            "ICMM deleted its logs and forgot your saved platforms, but couldn’t forget your \
             theme and notification choices: Permission denied (os error 13). The window’s size \
             and place are left as they were."
        );
        assert_eq!(
            unfinished(&steps, Step::Window, "the window is gone"),
            "ICMM deleted its logs, forgot your saved platforms and forgot your theme and \
             notification choices, but couldn’t forget the window’s size and place: the window \
             is gone."
        );
    }

    #[test]
    fn deleting_icmm_s_key_is_a_step_of_its_own() {
        let steps = [Step::Key, Step::Platforms, Step::Preferences, Step::Window];
        assert_eq!(
            unfinished(&steps, Step::Key, "Permission denied (os error 13)"),
            "ICMM deleted its logs, but couldn’t delete ICMM’s SSH key: Permission denied (os \
             error 13). Your saved platforms, your theme and notification choices and the \
             window’s size and place are left as they were."
        );
        assert_eq!(
            unfinished(&steps, Step::Platforms, "Permission denied (os error 13)"),
            "ICMM deleted its logs and deleted ICMM’s SSH key, but couldn’t forget your saved \
             platforms: Permission denied (os error 13). Your theme and notification choices and \
             the window’s size and place are left as they were."
        );
    }
}
