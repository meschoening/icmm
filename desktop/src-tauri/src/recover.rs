//! ICMM picks up This computer's stopped runs each time it opens, whatever
//! the Active platform (ADR-0019): once This computer has a runs database, it
//! runs `icmm recover` from This computer's engine, which relaunches every run
//! whose coordinator is gone.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::engine::{self, BundleError, Engine, Engines, host_target};
use crate::platforms::store::tilde;

/// A Data folder's runs database (`icmm.db.FILE_NAME`).
const RUNS_DB: &str = "runs.db";
/// How long a pass, which takes seconds, is waited for; one still going
/// after this is left to finish.
const TIMEOUT: Duration = Duration::from_secs(120);
/// How long its stderr may stay open once it has exited.
const STDERR_GRACE: Duration = Duration::from_secs(5);
/// How `icmm recover` starts each line that says it relaunched a run.
const RELAUNCHED: &str = "relaunched run #";

/// Whether This computer's Data folder is set up: it has the runs database
/// the agent makes on its first connect.
pub fn set_up(data_folder: &Path) -> bool {
    data_folder.join(RUNS_DB).is_file()
}

/// Runs `<engine>/<interpreter> -I -m icmm recover --data-folder <folder>`,
/// installing the engine into `<folder>/engine/` first when it's missing. A
/// Data folder never set up is left as it is. It isn't killed when the app
/// quits, nor when it runs past its time: a pass may be launching a
/// coordinator, so it's left to finish. With a `limit`, every wait (the
/// pass, its stderr, the install's self-check and renames, the runs
/// database's busy wait) may take up to it, rather than its own.
pub async fn recover(
    engine: Engine,
    data_folder: PathBuf,
    limit: Option<Duration>,
) -> Result<(), String> {
    if !set_up(&data_folder) {
        return Ok(());
    }
    let bundle = engine.bundle().await.map_err(|e| match e {
        BundleError::Missing(found) => found,
        BundleError::Stopped(why) => format!("looking for its engine stopped: {why}"),
    })?;
    let root = data_folder.join(engine::FOLDER);
    if !engine::local::installed(&bundle, &root) {
        let (installing, into) = (bundle.clone(), root.clone());
        tokio::task::spawn_blocking(move || engine::local::install(&installing, &into, limit))
            .await
            .map_err(|e| format!("its engine's install stopped: {e}"))?
            .map_err(|e| format!("couldn't install its engine in {}: {e:?}", tilde(&root)))?;
    }
    let python = engine::local::folder(&bundle, &root).join(bundle.interpreter());
    let mut command = Command::new(&python);
    command
        .args(["-I", "-m", "icmm", "recover", "--data-folder"])
        .arg(&data_folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(limit) = limit {
        command.envs(engine::env_waiting_up_to(limit));
    }
    #[cfg(windows)]
    {
        // No console window flashes up beside the app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("couldn't run {}: {e}", python.display()))?;
    let mut stderr = child.stderr.take().expect("piped");
    // Read while it runs, so a long traceback never fills the pipe.
    let said = tokio::spawn(async move {
        let mut said = Vec::new();
        let _ = stderr.read_to_end(&mut said).await;
        String::from_utf8_lossy(&said).into_owned()
    });
    let within = limit.unwrap_or(TIMEOUT);
    let status = match tokio::time::timeout(within, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => return Err(format!("lost {}: {e}", python.display())),
        Err(_) => {
            return Err(format!(
                "it was still running after {} s, and is left to finish",
                within.as_secs()
            ));
        }
    };
    let said = match tokio::time::timeout(limit.unwrap_or(STDERR_GRACE), said).await {
        Ok(Ok(said)) => said,
        _ => String::new(),
    };
    if status.success() {
        let said = said.trim_end();
        if troubled(said) {
            tracing::warn!("icmm recover said:\n{said}");
        } else if !said.is_empty() {
            tracing::info!("icmm recover said:\n{said}");
        }
        return Ok(());
    }
    match last_line(&said) {
        "" => Err(format!("it ended with {status}")),
        why => Err(format!("it ended with {status} · {why}")),
    }
}

/// Starts `recover` on This computer's Data folder, with This computer's
/// engine from `engines`, and logs how it went.
pub fn start(engines: &Engines, data_folder: PathBuf) {
    let engine = Engine::Find(engines.clone(), host_target());
    tauri::async_runtime::spawn(async move {
        let shown = tilde(&data_folder);
        if !set_up(&data_folder) {
            return tracing::info!("no runs database in {shown} yet, so no runs to recover");
        }
        let started = Instant::now();
        match recover(engine, data_folder, None).await {
            Ok(()) => tracing::info!(
                "recovered This computer's runs in {shown} in {:.1?}",
                started.elapsed()
            ),
            Err(e) => tracing::warn!("couldn't recover This computer's runs in {shown}: {e}"),
        }
    });
}

/// Whether a pass that succeeded said more than which runs it relaunched: a
/// run it couldn't relaunch, or other trouble it got past.
fn troubled(said: &str) -> bool {
    said.lines()
        .map(str::trim)
        .any(|l| !l.is_empty() && !l.starts_with(RELAUNCHED))
}

/// The last line with something on it: a traceback's says why.
fn last_line(said: &str) -> &str {
    said.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The limit for a pass that's meant to finish: far beyond any slowness,
    /// so only a hang outlasts it. A year rather than `Duration::MAX`, so it
    /// can't overflow added to now.
    const NEVER: Option<Duration> = Some(Duration::from_secs(365 * 24 * 60 * 60));

    /// An engine `Engines` never finds: a test that looks for it fails.
    fn none() -> Engine {
        Engine::Find(Engines::from_fn(|_| Err("none".into())), host_target())
    }

    #[test]
    fn a_folder_without_a_runs_database_isnt_set_up() {
        let data = tempfile::tempdir().unwrap();

        assert!(!set_up(data.path()));
    }

    #[test]
    fn a_folder_with_a_runs_database_is_set_up() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("runs.db"), b"").unwrap();

        assert!(set_up(data.path()));
    }

    #[tokio::test]
    async fn a_folder_never_set_up_is_left_as_it_is() {
        let data = tempfile::tempdir().unwrap();

        recover(none(), data.path().to_owned(), NEVER)
            .await
            .unwrap();

        assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_set_up_folder_without_an_engine_says_so() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("runs.db"), b"").unwrap();

        let failed = recover(none(), data.path().to_owned(), NEVER)
            .await
            .unwrap_err();

        assert!(failed.contains("none"), "{failed}");
    }

    /// A bundle installed under `<data>/engine/` whose interpreter is the
    /// shell script `script`.
    #[cfg(unix)]
    fn installed(data: &std::path::Path, script: &str) -> Engine {
        use crate::engine::{Bundle, MANIFEST, Manifest};

        let key = "0.0.0-test-none-000000000000";
        let bundle = Bundle {
            key: key.into(),
            sha256: "0".repeat(64),
            archive: "no-engine.tar.zst".into(),
            archive_bytes: 0,
            manifest: Manifest {
                key: key.into(),
                protocol: crate::wire::commands::PROTOCOL_VERSION.into(),
                files: 0,
                bytes: 0,
                glibc: None,
            },
        };
        let folder = data.join(crate::engine::FOLDER).join(key);
        let python = folder.join(bundle.interpreter());
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(folder.join(MANIFEST), b"{}").unwrap();
        // Written by a child process, so this one never holds it open for
        // writing: a fork on another test thread keeps a copy of this
        // process's descriptors until it execs, and running a script that's
        // open for writing fails with ETXTBSY (on Linux).
        let wrote = std::process::Command::new("/bin/sh")
            .args(["-c", r#"printf '%s\n' "$2" > "$1" && chmod 755 "$1""#, "sh"])
            .arg(&python)
            .arg(format!("#!/bin/sh\n{script}"))
            .status()
            .unwrap();
        assert!(wrote.success(), "writing {} {wrote}", python.display());
        bundle.into()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn it_runs_icmm_recover_on_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("runs.db"), b"").unwrap();
        let args = data.path().join("args");
        let engine = installed(
            data.path(),
            &format!("printf '%s\\n' \"$@\" > '{}'", args.display()),
        );

        recover(engine, data.path().to_owned(), NEVER)
            .await
            .unwrap();

        let ran = std::fs::read_to_string(&args).unwrap();
        let expected = format!(
            "-I\n-m\nicmm\nrecover\n--data-folder\n{}\n",
            data.path().display()
        );
        assert_eq!(ran, expected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_recover_says_its_last_line() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("runs.db"), b"").unwrap();
        let engine = installed(
            data.path(),
            "echo 'Traceback (most recent call last):' >&2\n\
             echo '  File \"recover.py\", line 1' >&2\n\
             echo 'sqlite3.OperationalError: disk I/O error' >&2\n\
             echo >&2\n\
             exit 1",
        );

        let failed = recover(engine, data.path().to_owned(), NEVER)
            .await
            .unwrap_err();

        assert!(
            failed.ends_with("sqlite3.OperationalError: disk I/O error"),
            "{failed}"
        );
    }

    #[test]
    fn a_pass_is_troubled_when_it_says_more_than_what_it_relaunched() {
        assert!(!troubled(""));
        assert!(!troubled("relaunched run #3\nrelaunched run #4\n"));
        assert!(troubled(
            "relaunched run #3\nrun #4's coordinator can't be relaunched yet: \
             [Errno 11] Resource temporarily unavailable"
        ));
        assert!(troubled(
            "run #5 couldn't be relaunched:\nTraceback (most recent call last):"
        ));
    }
}
