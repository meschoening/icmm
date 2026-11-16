//! This computer: the agent is a child process of the app, run from the
//! engine bundle installed in the Data folder.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::said::{self, REPORT, Said, icmm_retry_once};
use super::transport::{AgentPipes, BoxFuture, ConnectError, Progress, Session, Transport};
use crate::engine::local::InstallError;
use crate::engine::{self, Bundle, Engine};
use crate::platforms::store::tilde;
use crate::wire::types::{ConnectFailure, ConnectFix};

/// Runs `<engine>/<interpreter> -I -m icmm agent --serve --data-folder <folder>`
/// here, installing the engine first when it's missing.
pub struct Local {
    engine: Engine,
    data_folder: PathBuf,
    /// Every wait's length, when it isn't each one's own.
    limit: Option<Duration>,
}

impl Local {
    pub fn new(engine: impl Into<Engine>, data_folder: PathBuf) -> Local {
        Local {
            engine: engine.into(),
            data_folder,
            limit: None,
        }
    }

    /// Each of its waits may take up to `limit`, rather than its own: an
    /// install's self-check and Windows holding its folder, and the agent's
    /// idle exit and its runs database's busy wait (`ICMM_AGENT_IDLE_TIMEOUT_S`
    /// and `ICMM_BUSY_TIMEOUT_MS` in its environment, which is otherwise the
    /// app's).
    pub fn waiting_up_to(self, limit: Duration) -> Local {
        Local {
            limit: Some(limit),
            ..self
        }
    }
}

impl Transport for Local {
    fn open(&self, _progress: Progress) -> BoxFuture<'_, Result<Box<dyn Session>, ConnectError>> {
        Box::pin(async move {
            let engine = self
                .engine
                .bundle()
                .await
                .map_err(|e| ConnectError::fatal(said::no_bundle(e, "this computer")))?;
            Ok(Box::new(LocalSession {
                engine,
                data_folder: self.data_folder.clone(),
                limit: self.limit,
            }) as Box<dyn Session>)
        })
    }

    fn local(&self) -> bool {
        true
    }

    fn data_folder(&self) -> String {
        tilde(&self.data_folder)
    }
}

/// Retry, then reinstall, then report it: what's left when ICMM's own files
/// won't run.
fn reinstall() -> String {
    format!("Retry once. If it fails again, reinstall ICMM; if that doesn’t help, {REPORT}.")
}

/// What an install into `root`, in the Data folder `data_folder`, that
/// failed says.
fn install_failed(e: InstallError, data_folder: &Path, root: &Path) -> ConnectError {
    let said = match e {
        InstallError::Folder { step, error } => Said::new(
            format!(
                "ICMM couldn’t install its engine in {} on this computer.",
                tilde(data_folder)
            ),
            "Retry in a moment. If it fails again, check that you can write there.",
        )
        .details(format!("{} · {step}: {error}", tilde(root))),
        InstallError::Run { python, error } => Said::new(
            "ICMM couldn’t run its engine on this computer.",
            reinstall(),
        )
        .details(format!("{} · {error}", python.display()))
        .fix(ConnectFix::Report),
        InstallError::Unfinished => Said::new(
            "ICMM’s engine on this computer didn’t finish its self-check.",
            icmm_retry_once(),
        )
        .fix(ConnectFix::Report),
        InstallError::Failed(error) => Said::new(
            "ICMM’s engine on this computer didn’t pass its self-check.",
            icmm_retry_once(),
        )
        .details(error)
        .fix(ConnectFix::Report),
    };
    ConnectError::transient(said).because(ConnectFailure::Engine)
}

/// This computer, with the engine it runs.
struct LocalSession {
    engine: Bundle,
    data_folder: PathBuf,
    limit: Option<Duration>,
}

impl LocalSession {
    fn root(&self) -> PathBuf {
        self.data_folder.join(engine::FOLDER)
    }
}

impl Session for LocalSession {
    fn start_agent(&self) -> BoxFuture<'_, Result<AgentPipes, ConnectError>> {
        Box::pin(async move {
            let LocalSession {
                engine,
                data_folder,
                limit,
            } = self;
            let root = self.root();
            if !engine::local::installed(engine, &root) {
                let folder = engine::local::folder(engine, &root);
                return Err(ConnectError::no_engine(tilde(&folder)));
            }
            let python = engine::local::folder(engine, &root).join(engine.interpreter());
            let mut command = Command::new(&python);
            command
                .args(["-I", "-m", "icmm", "agent", "--serve", "--data-folder"])
                .arg(data_folder)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            if let Some(limit) = *limit {
                command.envs(engine::env_waiting_up_to(limit));
            }
            #[cfg(windows)]
            {
                // No console window flashes up beside the app.
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = command.spawn().map_err(|e| {
                ConnectError::fatal(
                    Said::new("ICMM’s engine didn’t start on this computer.", reinstall())
                        .details(format!("{} · {e}", python.display()))
                        .fix(ConnectFix::Report),
                )
                .because(ConnectFailure::Engine)
            })?;
            let pipes = (child.stdout.take(), child.stdin.take(), child.stderr.take());
            let (Some(stdout), Some(stdin), Some(stderr)) = pipes else {
                unreachable!("all three are piped")
            };
            Ok(AgentPipes {
                stdout: Box::new(stdout),
                stdin: Box::new(stdin),
                stderr: Box::new(stderr),
                // Killed when dropped (`kill_on_drop`).
                guard: Box::new(child),
            })
        })
    }

    fn install_engine(&self) -> BoxFuture<'_, Result<(), ConnectError>> {
        Box::pin(async move {
            let (engine, root, limit) = (self.engine.clone(), self.root(), self.limit);
            let at = root.clone();
            tokio::task::spawn_blocking(move || engine::local::install(&engine, &root, limit))
                .await
                .map_err(|e| {
                    ConnectError::transient(
                        Said::new(
                            "ICMM’s engine install on this computer stopped.",
                            format!("Retry once. If it fails again, {REPORT}."),
                        )
                        .details(e.to_string())
                        .fix(ConnectFix::Report),
                    )
                })?
                .map_err(|e| install_failed(e, &self.data_folder, &at))
        })
    }

    fn set_engine_aside(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let (engine, root, limit) = (self.engine.clone(), self.root(), self.limit);
            tokio::task::spawn_blocking(move || engine::local::set_aside(&engine, &root, limit))
                .await
                .map_err(|e| e.to_string())?
        })
    }

    fn closed(&self) -> BoxFuture<'_, ()> {
        Box::pin(std::future::pending())
    }

    fn probe(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
}
