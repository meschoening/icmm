//! Export's and Import's dataset files on this computer (#147), Compare's
//! folder of figures (#342), and a start's, the leaderboard's and a run's
//! exports (#344). The host engine reads and writes them
//! (ADR-0013); this keeps the paths the save dialogs answered, the only ones
//! Export writes and Show in Finder shows, so the page can't write or open
//! any other.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The save dialog's answers in this session.
static CHOSEN: Mutex<Answers> = Mutex::new(Answers(Vec::new()));
/// Enough for a long session; the oldest is forgotten first.
const KEPT: usize = 64;

/// The extension a dataset file has, which both dialogs filter to.
pub const EXTENSION: &str = "zip";

/// Paths a save dialog answered, newest last.
struct Answers(Vec<PathBuf>);

impl Answers {
    fn add(&mut self, path: &Path) {
        self.0.retain(|p| p != path);
        self.0.push(path.to_owned());
        if self.0.len() > KEPT {
            self.0.remove(0);
        }
    }

    fn has(&self, path: &Path) -> bool {
        self.0.iter().any(|p| p == path)
    }
}

/// Keeps `path`, which the save dialog answered.
pub fn chose(path: &Path) {
    CHOSEN.lock().unwrap_or_else(|e| e.into_inner()).add(path);
}

/// Whether the save dialog answered `path` in this session.
pub fn was_chosen(path: &Path) -> bool {
    CHOSEN.lock().unwrap_or_else(|e| e.into_inner()).has(path)
}

/// Shows `file`, or a folder, in the OS's file manager: selected in Finder or
/// Explorer, and on Linux its folder, which `xdg-open` opens in the file
/// manager.
pub fn reveal(file: &Path) -> std::io::Result<()> {
    if !file.exists() {
        return Err(std::io::ErrorKind::NotFound.into());
    }
    // `~/` expands with `/` after the home folder; Explorer selects only a
    // path in its own separators.
    let file: PathBuf = file.components().collect();
    let file = file.as_path();
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(file);
        c
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer");
        // One argument, as Explorer parses it: `/select,` and the path, quoted.
        c.raw_arg(format!("/select,\"{}\"", file.display()));
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(file.parent().unwrap_or(Path::new("/")));
        c
    };
    // Explorer exits with 1 even when it showed the file, so only a spawn
    // that fails is a failure; the exit is collected off the main thread.
    let mut child = command.spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_path_the_save_dialog_answered_is_chosen() {
        let path = PathBuf::from("/tmp/icmm-test/one/herg-wt.zip");
        assert!(!was_chosen(&path));
        chose(&path);
        assert!(was_chosen(&path));
        assert!(!was_chosen(Path::new("/tmp/icmm-test/one/other.zip")));
        assert!(!was_chosen(Path::new("/tmp/icmm-test/one")));
    }

    #[test]
    fn the_oldest_answer_is_forgotten_past_the_limit() {
        let mut answers = Answers(Vec::new());
        let first = PathBuf::from("/0.zip");
        answers.add(&first);
        for i in 1..=KEPT {
            answers.add(&PathBuf::from(format!("/{i}.zip")));
        }
        assert!(!answers.has(&first));
        assert!(answers.has(Path::new("/1.zip")));
        answers.add(Path::new("/1.zip"));
        assert_eq!(answers.0.len(), KEPT);
    }

    #[test]
    fn revealing_a_file_that_isnt_there_fails_without_opening_anything() {
        let e = reveal(Path::new("/tmp/icmm-test/none/herg-wt.zip")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::NotFound);
    }
}
