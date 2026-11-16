//! How the supervisor reaches a platform, whatever the platform kind: open a
//! session (sign in over SSH; nothing locally), then start agents on it.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use super::host_key::HostKeyQuestion;
use super::said::Said;
use crate::wire::types::{ConnectFailure, ConnectStep, Upload};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Takes each step of a connect as the transport reaches it, with the
/// engine's upload while it lasts.
pub type Progress = Arc<dyn Fn(ConnectStep, Option<Upload>) + Send + Sync>;

/// Where a connect stopped, and whether trying again could help.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectError {
    /// What it says to the user.
    pub said: Box<Said>,
    /// Trying again can't help without the user: a host key that doesn't
    /// match, a sign-in the host refused (clusters block an address that
    /// keeps failing), or an engine on another protocol.
    pub fatal: bool,
    /// The platform hasn't this app's engine yet: install it, then start again.
    pub no_engine: bool,
    /// What it needs before a connect can work.
    pub kind: ConnectFailure,
    /// A host key known_hosts doesn't vouch for: unknown, which the user may
    /// trust, or changed, whose old key they may forget.
    pub host_key: Option<Box<HostKeyQuestion>>,
    /// A sign-in no key got through, which the user may add a key for.
    pub sign_in: Option<Box<Refusal>>,
}

/// A sign-in no key got through: what asking the user for a key needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// Which host on the route refused, counted from the first; the login
    /// host is last.
    pub hop: usize,
    pub host: String,
    pub user: String,
    /// The keys it refused, as a sentence names them; empty when this
    /// computer had none to offer.
    pub tried: Vec<String>,
    /// Whether it takes a password, which can add ICMM's key there.
    pub password: bool,
    /// Whether the key it refused is ICMM's, which the platform signs in
    /// to it with.
    pub icmm_key_refused: bool,
}

/// Why ICMM's key couldn't be added to a host.
#[derive(Debug)]
pub enum AddKeyError {
    /// The host refused the password: the user may try another.
    WrongPassword,
    /// The host takes no password at all.
    NoPassword,
    /// Anything else, as a connect that failed there would say it.
    Failed(ConnectError),
}

impl ConnectError {
    pub fn fatal(said: Said) -> ConnectError {
        ConnectError {
            said: Box::new(said),
            fatal: true,
            no_engine: false,
            kind: ConnectFailure::Other,
            host_key: None,
            sign_in: None,
        }
    }

    pub fn transient(said: Said) -> ConnectError {
        ConnectError {
            said: Box::new(said),
            fatal: false,
            no_engine: false,
            kind: ConnectFailure::Other,
            host_key: None,
            sign_in: None,
        }
    }

    /// The engine isn't in `folder` (as a sentence names it), where it starts from.
    pub fn no_engine(folder: impl Into<String>) -> ConnectError {
        ConnectError {
            said: Box::new(
                Said::new("ICMM’s engine isn’t installed.", "Retry to install it.").details(folder),
            ),
            fatal: false,
            no_engine: true,
            kind: ConnectFailure::Engine,
            host_key: None,
            sign_in: None,
        }
    }

    /// The same error, saying what it needs.
    pub fn because(self, kind: ConnectFailure) -> ConnectError {
        ConnectError { kind, ..self }
    }

    /// The same error, about a host key the user can act on.
    pub fn about(self, question: HostKeyQuestion) -> ConnectError {
        ConnectError {
            host_key: Some(Box::new(question)),
            ..self
        }
    }

    /// The same error, about a sign-in the user can add a key for.
    pub fn refused(self, refusal: Refusal) -> ConnectError {
        ConnectError {
            sign_in: Some(Box::new(refusal)),
            ..self
        }
    }
}

pub trait Transport: Send + Sync + 'static {
    /// Reaches the platform. The session reports its steps to `progress`.
    fn open(&self, progress: Progress) -> BoxFuture<'_, Result<Box<dyn Session>, ConnectError>>;

    /// Where ICMM's key is, on a platform that signs in with keys.
    fn icmm_key(&self) -> Option<PathBuf> {
        None
    }

    /// Whether the platform is this computer, which sentences name so.
    fn local(&self) -> bool {
        false
    }

    /// How many hosts a connect signs in to, the login host last.
    fn hops(&self) -> usize {
        1
    }

    /// The Data folder, as the user wrote it.
    fn data_folder(&self) -> String {
        "the Data folder".into()
    }

    /// Adds ICMM's key, made first when this computer hasn't one, to host
    /// `hop` on the way, signing in there with `password`; answers the key's
    /// file.
    fn add_key<'a>(
        &'a self,
        _hop: usize,
        _password: &'a str,
    ) -> BoxFuture<'a, Result<PathBuf, AddKeyError>> {
        Box::pin(async { Err(AddKeyError::Failed(without_key())) })
    }

    /// The same platform, signing in to host `hop` with the key in `file`;
    /// `None` on a platform that signs in without one.
    fn with_key(&self, _hop: usize, _file: &Path) -> Option<Box<dyn Transport>> {
        None
    }
}

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn open(&self, progress: Progress) -> BoxFuture<'_, Result<Box<dyn Session>, ConnectError>> {
        (**self).open(progress)
    }

    fn icmm_key(&self) -> Option<PathBuf> {
        (**self).icmm_key()
    }

    fn local(&self) -> bool {
        (**self).local()
    }

    fn hops(&self) -> usize {
        (**self).hops()
    }

    fn data_folder(&self) -> String {
        (**self).data_folder()
    }

    fn add_key<'a>(
        &'a self,
        hop: usize,
        password: &'a str,
    ) -> BoxFuture<'a, Result<PathBuf, AddKeyError>> {
        (**self).add_key(hop, password)
    }

    fn with_key(&self, hop: usize, file: &Path) -> Option<Box<dyn Transport>> {
        (**self).with_key(hop, file)
    }
}

/// A key asked for where the platform signs in without one.
pub fn without_key() -> ConnectError {
    ConnectError::fatal(Said::new(
        "This computer signs in without a key, so there’s none to add.",
        "Retry to connect.",
    ))
}

pub trait Session: Send + Sync {
    /// Starts an agent, or fails with `ConnectError::no_engine` when the
    /// platform hasn't the engine yet.
    fn start_agent(&self) -> BoxFuture<'_, Result<AgentPipes, ConnectError>>;
    /// Installs the engine on the platform. It takes as long as it takes.
    fn install_engine(&self) -> BoxFuture<'_, Result<(), ConnectError>>;
    /// Moves the engine's folder aside, so the next start finds it missing
    /// and installs it again: an engine that speaks another protocol than
    /// its bundle says.
    fn set_engine_aside(&self) -> BoxFuture<'_, Result<(), String>>;
    /// Resolves when the link itself is gone (never, locally).
    fn closed(&self) -> BoxFuture<'_, ()>;
    /// Whether the link still carries traffic: asked after the machine wakes.
    fn probe(&self) -> BoxFuture<'_, bool>;
}

/// One agent's stdout, stdin and stderr. Dropping it ends the agent: its
/// process is killed, or its channel closed.
pub struct AgentPipes {
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stderr: Box<dyn AsyncRead + Send + Unpin>,
    /// Holds the agent open; its drop ends it.
    pub guard: Box<dyn Send + Sync>,
}
