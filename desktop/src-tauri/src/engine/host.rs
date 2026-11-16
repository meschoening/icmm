//! The host engine: this computer's own **Engine bundle**, which the desktop
//! runs for the computation ADR-0013 keeps off a cluster's login node (the
//! Dataset wizard's interpolation and proposed split), whatever the Active
//! platform.
//!
//! It lives in a folder of the app's own, not in a Data folder: a user whose
//! only platform is a cluster has none on this computer, and This computer's
//! can move. It installs as This computer's does (`local::install`): from
//! launch when it's missing, and a call waits for that install. One
//! `icmm host --serve` process answers every call, started by the first and
//! kept while it's used: starting one takes about 0.12 s on an M1 Pro, and a
//! Redraw answers the page in about 1 ms once it runs (ADR-0015).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::{Bundle, Engine, local};
use crate::agent::{Agent, CallError};
use crate::connection::said::REPORT;
use crate::wire::types::{InternalData, WireError};

/// How long a call may take: the wizard's take milliseconds, and a timing seconds.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a new process may take to answer its first ping: seconds on a
/// first run under a virus scan.
const START_TIMEOUT: Duration = Duration::from_secs(30);

pub struct HostEngine {
    engine: Engine,
    root: PathBuf,
    /// How long a call may take, and a new process to answer its first ping.
    call_timeout: Duration,
    start_timeout: Duration,
    /// How long an install's self-check and Windows holding its folder may
    /// take, when not their own.
    install_limit: Option<Duration>,
    /// Installs one at a time: launch's, and a call's that finds it missing.
    installing: tokio::sync::Mutex<()>,
    running: tokio::sync::Mutex<Option<Arc<Running>>>,
}

/// A serving process, killed when the last call using it lets it go.
struct Running {
    agent: Agent,
    child: std::sync::Mutex<Child>,
}

impl HostEngine {
    /// The host engine `engine`, installed under `root`.
    pub fn new(engine: impl Into<Engine>, root: PathBuf) -> HostEngine {
        HostEngine {
            engine: engine.into(),
            root,
            call_timeout: CALL_TIMEOUT,
            start_timeout: START_TIMEOUT,
            install_limit: None,
            installing: tokio::sync::Mutex::new(()),
            running: tokio::sync::Mutex::new(None),
        }
    }

    /// A call, a new process's first answer, and an install's self-check
    /// and Windows holding its folder, may take up to `limit` rather than
    /// their own.
    pub fn waiting_up_to(self, limit: Duration) -> HostEngine {
        HostEngine {
            call_timeout: limit,
            start_timeout: limit,
            install_limit: Some(limit),
            ..self
        }
    }

    /// Installs the engine when it's missing, as launch does so that the
    /// first call seldom waits for it. A failure is logged, and the next call
    /// tries again.
    pub async fn prepare(&self) {
        match self.engine.bundle().await {
            Ok(bundle) => {
                let _ = self.install(&bundle).await;
            }
            Err(e) => tracing::error!("no host engine: {e:?}"),
        }
    }

    /// Calls `method` on the host engine, installing and starting it first
    /// when it isn't running. Its `invalid` and `internal` answers come back
    /// as it sent them; anything else that goes wrong is `internal`, said in
    /// the app log.
    pub async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: &P,
    ) -> Result<R, WireError> {
        let params = serde_json::to_value(params).expect("wire params encode");
        let mut sent_again = false;
        let result = loop {
            let running = self.running().await?;
            match running
                .agent
                .request(method, Some(params.clone()), self.call_timeout)
                .await
            {
                Ok(result) => break result,
                Err(CallError::Agent(
                    error @ (WireError::Invalid { .. } | WireError::Internal { .. }),
                )) => {
                    return Err(error);
                }
                // Any other answer is the desktop's own mistake, such as a
                // request the engine can't read.
                Err(CallError::Agent(error)) => {
                    return Err(stopped(format!("{method}: the engine answered {error:?}")));
                }
                // It exited as the call went out, after its quiet time, say:
                // every call is pure, so another process takes it.
                Err(CallError::Closed) if !sent_again => sent_again = true,
                Err(e) => return Err(stopped(format!("{method}: {e:?}"))),
            }
        };
        serde_json::from_value(result)
            .map_err(|e| stopped(format!("{method}: the engine's reply didn't fit: {e}")))
    }

    /// Ends the serving process, as its quiet time does, and resolves once
    /// it has: the next call starts another.
    pub async fn end(&self) {
        let running = self.running.lock().await.clone();
        if let Some(running) = running {
            let _ = running.child.lock().unwrap().start_kill();
            running.agent.closed().await;
        }
    }

    /// The running process, started when there's none or it has exited.
    async fn running(&self) -> Result<Arc<Running>, WireError> {
        let mut running = self.running.lock().await;
        if let Some(r) = running.as_ref()
            && !r.agent.is_closed()
        {
            return Ok(r.clone());
        }
        let bundle = self
            .engine
            .bundle()
            .await
            .map_err(|e| missing(format!("{e:?}")))?;
        self.install(&bundle).await?;
        let started = match self.start(&bundle).await {
            Ok(started) => started,
            Err(why) => {
                // A new process that won't answer is a damaged install: it's
                // set aside and installed afresh, once.
                tracing::warn!("the host engine didn't start ({why}); installing it again");
                self.set_aside(&bundle).await?;
                self.install(&bundle).await?;
                self.start(&bundle).await.map_err(stopped)?
            }
        };
        let started = Arc::new(started);
        *running = Some(started.clone());
        Ok(started)
    }

    /// Moves the installed `bundle` aside, so that the next install is afresh.
    async fn set_aside(&self, bundle: &Bundle) -> Result<(), WireError> {
        let _one = self.installing.lock().await;
        let (bundle, root, limit) = (bundle.clone(), self.root.clone(), self.install_limit);
        tokio::task::spawn_blocking(move || local::set_aside(&bundle, &root, limit))
            .await
            .map_err(|e| not_installed(format!("setting it aside stopped: {e}")))?
            .map_err(|e| not_installed(format!("setting it aside: {e}")))
    }

    /// Installs `bundle` when it's missing.
    async fn install(&self, bundle: &Bundle) -> Result<(), WireError> {
        let _one = self.installing.lock().await;
        if local::installed(bundle, &self.root) {
            return Ok(());
        }
        let (bundle, root, limit) = (bundle.clone(), self.root.clone(), self.install_limit);
        tokio::task::spawn_blocking(move || local::install(&bundle, &root, limit))
            .await
            .map_err(|e| not_installed(format!("it stopped: {e}")))?
            .map_err(|e| not_installed(format!("{e:?}")))
    }

    /// Starts a serving process from the installed `bundle`, once it answers.
    async fn start(&self, bundle: &Bundle) -> Result<Running, String> {
        let python = local::folder(bundle, &self.root).join(bundle.interpreter());
        let mut command = Command::new(&python);
        command
            .args(["-I", "-m", "icmm", "host", "--serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // No console window flashes up beside the app.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("{}: {e}", python.display()))?;
        let pipes = (child.stdout.take(), child.stdin.take(), child.stderr.take());
        let (Some(stdout), Some(stdin), Some(stderr)) = pipes else {
            unreachable!("all three are piped")
        };
        tokio::spawn(log_lines(stderr));
        let agent = Agent::new(stdout, stdin);
        agent
            .ping(self.start_timeout)
            .await
            .map_err(|e| format!("it didn't answer: {e:?}"))?;
        Ok(Running {
            agent,
            child: std::sync::Mutex::new(child),
        })
    }
}

/// Writes what the engine says on stderr, a line per call and the traceback
/// behind an `internal` error, into the app log.
async fn log_lines(stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::info!(target: "icmm_desktop::host_engine", "{line}");
    }
}

/// The app carries no engine for this computer.
fn missing(details: String) -> WireError {
    failed(
        format!(
            "This copy of ICMM is missing the engine this computer needs. Reinstall ICMM; if \
             that doesn’t help, {REPORT}."
        ),
        details,
    )
}

fn not_installed(details: String) -> WireError {
    failed(
        format!(
            "ICMM couldn’t install its engine on this computer. Retry in a moment; if it fails \
             again, {REPORT}."
        ),
        details,
    )
}

fn stopped(details: String) -> WireError {
    failed(
        format!(
            "ICMM’s engine on this computer stopped while it worked. Retry once; if it fails \
             again, {REPORT}."
        ),
        details,
    )
}

/// A failure the user can't fix from the app, said as `message`; the app log
/// holds `details`.
fn failed(message: String, details: String) -> WireError {
    tracing::error!("the host engine failed: {message} · {details}");
    WireError::Internal {
        message,
        data: InternalData {
            log_ref: "app.log".into(),
        },
    }
}
