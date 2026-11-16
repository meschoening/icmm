//! Installing a bundle on This computer: the archive the app carries is
//! unpacked beside `<root>/<key>/`, proves it runs, then is renamed into place.
//! The rename is the commit, so a cut install leaves only a `.staging-*`
//! folder, which a later install removes. The app never runs an engine from
//! inside itself: local runs outlive it, and an update replaces it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use super::{Bundle, MANIFEST, selfcheck_error};

/// A self-check that takes longer is stuck: it takes seconds, even on a first
/// run under a virus scan.
const SELFCHECK_TIMEOUT: Duration = Duration::from_secs(120);
/// A staging folder this old is a cut install's, not one under way.
const STALE_STAGING: Duration = Duration::from_secs(60 * 60);

/// The bundle's folder under `root`, whether or not it's installed.
pub fn folder(bundle: &Bundle, root: &Path) -> PathBuf {
    root.join(&bundle.key)
}

/// Whether `bundle` is installed under `root`.
pub fn installed(bundle: &Bundle, root: &Path) -> bool {
    folder(bundle, root).join(MANIFEST).is_file()
}

/// Why an install failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// A step in `root` failed: making its folder, unpacking, moving it.
    Folder { step: String, error: String },
    /// The unpacked engine's interpreter couldn't be run.
    Run { python: PathBuf, error: String },
    /// Its self-check ran past its time.
    Unfinished,
    /// Its self-check failed, saying why.
    Failed(String),
}

/// Installs `bundle` under `root`. Blocks for a few seconds, and up to 10 s
/// more while Windows holds its folder. With a `limit`, its self-check may
/// take up to it, and Windows may hold the folder that long in all.
pub fn install(bundle: &Bundle, root: &Path, limit: Option<Duration>) -> Result<(), InstallError> {
    let failed = |step: &str, e: &dyn std::fmt::Display| InstallError::Folder {
        step: step.to_owned(),
        error: e.to_string(),
    };
    std::fs::create_dir_all(root).map_err(|e| failed("making its folder", &e))?;
    remove_stale_staging(root);
    let staging = root.join(format!(
        ".staging-{}-{:08x}",
        std::process::id(),
        fastrand::u32(..)
    ));
    let target = folder(bundle, root);
    // A folder without its BUNDLE.json isn't an install: set it aside.
    if target.exists() && !installed(bundle, root) {
        let aside = staging.with_extension("broken");
        let step = "setting aside a broken install";
        while_refused(step, rename_waits(limit), || {
            std::fs::rename(&target, &aside)
        })
        .map_err(|e| failed(step, &e))?;
        remove(&aside);
    }
    let unpacked = staging.join(&bundle.key);
    let result = unpack(&bundle.archive, &unpacked)
        .map_err(|e| failed("unpacking it", &e))
        .and_then(|()| {
            let within = limit.unwrap_or(SELFCHECK_TIMEOUT);
            selfcheck(&unpacked.join(bundle.interpreter()), within)
        })
        .and_then(|()| {
            let step = "moving it into place";
            while_refused(step, rename_waits(limit), || {
                match std::fs::rename(&unpacked, &target) {
                    // Another install got there first.
                    Err(_) if installed(bundle, root) => Ok(()),
                    result => result,
                }
            })
            .map_err(|e| failed(step, &e))
        });
    remove(&staging);
    result
}

/// Moves `bundle`'s folder under `root` aside and removes it, so the next
/// start installs it again. With a `limit`, Windows may hold the folder up
/// to it in all.
pub fn set_aside(bundle: &Bundle, root: &Path, limit: Option<Duration>) -> Result<(), String> {
    let target = folder(bundle, root);
    if !target.exists() {
        return Ok(());
    }
    let aside = root.join(format!(
        ".staging-{}-{:08x}.aside",
        std::process::id(),
        fastrand::u32(..)
    ));
    while_refused("setting it aside", rename_waits(limit), || {
        std::fs::rename(&target, &aside)
    })
    .map_err(|e| e.to_string())?;
    remove(&aside);
    Ok(())
}

fn unpack(archive: &Path, into: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(into)?;
    let file = std::io::BufReader::new(std::fs::File::open(archive)?);
    let decoder = ruzstd::decoding::StreamingDecoder::new(file).map_err(std::io::Error::other)?;
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(true);
    tar.unpack(into)
}

/// Runs the unpacked engine's `icmm selfcheck`, which proves it imports and
/// loads its core, for up to `limit`.
fn selfcheck(python: &Path, limit: Duration) -> Result<(), InstallError> {
    let mut command = Command::new(python);
    command
        .args(["-I", "-m", "icmm", "selfcheck"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashes up beside the app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| InstallError::Run {
        python: python.to_owned(),
        error: e.to_string(),
    })?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < limit => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(InstallError::Unfinished);
            }
        }
    };
    if status.success() {
        return Ok(());
    }
    // Its output is a line or a traceback, well within a pipe's buffer.
    let mut said = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut said);
    }
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut said);
    }
    Err(InstallError::Failed(selfcheck_error(&said)))
}

/// Removes the staging folders of installs cut off long enough ago.
fn remove_stale_staging(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| {
                SystemTime::now()
                    .duration_since(m)
                    .is_ok_and(|age| age > STALE_STAGING)
            })
            .unwrap_or(false);
        if stale && entry.file_name().to_string_lossy().starts_with(".staging-") {
            remove(&entry.path());
        }
    }
}

/// How long a refused rename waits before each new try. Windows refuses to
/// rename a folder while a file in it is open, and just after the self-check
/// the engine's `.exe` and `.dll`s can be, for a moment: by the exiting
/// interpreter, or by a virus scan of their first run. So there it waits from
/// 10 ms, doubling to 1 s, about 10 s in all (or `limit`), as rustup retries
/// its renames for the same reason (rust-lang/rustup#1870). Elsewhere a
/// refusal is a real permission problem, said at once.
fn rename_waits(limit: Option<Duration>) -> impl Iterator<Item = Duration> {
    waits(cfg!(windows), limit)
}

/// The waits from 10 ms, doubling to 1 s: 16 of them, or as many as reach
/// `limit` in all; none when it isn't `retrying`.
fn waits(retrying: bool, limit: Option<Duration>) -> impl Iterator<Item = Duration> {
    let tries = match (retrying, limit) {
        (false, _) => 0,
        (true, None) => 16,
        (true, Some(_)) => usize::MAX,
    };
    let budget = limit.unwrap_or(Duration::MAX);
    (0..tries)
        .map(|i| Duration::from_millis((10 << i.min(7)).min(1000)))
        .scan(Duration::ZERO, move |waited, wait| {
            (*waited < budget).then(|| {
                *waited += wait;
                wait
            })
        })
}

/// Runs `step`'s `op`, and runs it again after each of `waits` while it's
/// refused (`PermissionDenied`); past the last wait, the refusal is the
/// result. Each refusal is logged, so one that clears still shows.
fn while_refused(
    step: &str,
    waits: impl IntoIterator<Item = Duration>,
    mut op: impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut waits = waits.into_iter();
    loop {
        match op() {
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => match waits.next() {
                Some(wait) => {
                    tracing::warn!(
                        "installing the engine, {step} was refused ({e}); trying again in {wait:?}"
                    );
                    std::thread::sleep(wait);
                }
                None => return Err(e),
            },
            result => return result,
        }
    }
}

fn remove(folder: &Path) {
    if let Err(e) = std::fs::remove_dir_all(folder)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("couldn't remove {}: {e}", folder.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    /// A rename that's refused `times` times, then goes through.
    fn refused(times: usize, tries: &mut usize) -> impl FnMut() -> std::io::Result<()> + '_ {
        move || {
            *tries += 1;
            if *tries <= times {
                Err(Error::from(ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn a_rename_refused_for_a_moment_goes_through() {
        let mut tries = 0;

        while_refused("renaming", [Duration::ZERO; 5], refused(3, &mut tries)).unwrap();

        assert_eq!(tries, 4);
    }

    #[test]
    fn a_rename_refused_past_the_last_wait_is_refused() {
        let mut tries = 0;

        let refusal = while_refused(
            "renaming",
            [Duration::ZERO; 5],
            refused(usize::MAX, &mut tries),
        )
        .unwrap_err();

        assert_eq!(refusal.kind(), ErrorKind::PermissionDenied);
        assert_eq!(tries, 6);
    }

    /// The waits are counted, not waited out.
    #[test]
    fn a_limit_lets_a_refusal_wait_that_long_in_all() {
        let usual: Vec<_> = waits(true, None).collect();
        let first: Vec<_> = usual.iter().take(8).map(Duration::as_millis).collect();
        assert_eq!(first, [10, 20, 40, 80, 160, 320, 640, 1000]);
        assert_eq!(usual.len(), 16, "about 10 s in all");

        let limit = Duration::from_secs(30);
        let limited: Vec<_> = waits(true, Some(limit)).collect();
        let total: Duration = limited.iter().sum();
        assert_eq!(limited[..16], usual[..]);
        assert!(
            total >= limit && total - limited[limited.len() - 1] < limit,
            "{total:?}"
        );
        let year = Duration::from_secs(365 * 24 * 60 * 60);
        assert_eq!(
            waits(true, Some(year)).nth(1000),
            Some(Duration::from_secs(1))
        );
        assert_eq!(waits(false, Some(limit)).count(), 0, "said at once");
    }

    #[test]
    fn only_a_refusal_is_tried_again() {
        let mut tries = 0;

        let missing = while_refused(
            "renaming",
            [Duration::ZERO; 5],
            || -> std::io::Result<()> {
                tries += 1;
                Err(Error::from(ErrorKind::NotFound))
            },
        )
        .unwrap_err();

        assert_eq!(missing.kind(), ErrorKind::NotFound);
        assert_eq!(tries, 1);
    }
}
