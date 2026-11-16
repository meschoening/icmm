//! An SSH platform: a russh session, signed in without asking anything (an
//! ssh-agent, or a key file without a passphrase), with each agent on its own
//! exec channel (docs/research/rust-ssh.md). A platform without the app's
//! engine gets it installed over two more execs (`engine::remote`).
//!
//! A platform filled in from a `~/.ssh/config` host that uses `ProxyJump`
//! is reached through its jump hosts in turn: each is signed in to on its
//! own, with its own host key checked, and opens a tunnel to the next.
//!
//! A host key must be in known_hosts. One that isn't, or that changed, stops
//! the connect with the question for the user (`HostKeyQuestion`). A host
//! that accepts none of this computer's keys stops it with what asking for a
//! key needs (`Refusal`): the password the user then gives is used once, to
//! add ICMM's key there (ADR-0012). Each failure says what it needs
//! (`ConnectFailure`), which picks its fix.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::{ChannelMsg, MethodKind};

use russh::client::{self, AuthResult, Handle};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::io::{
    AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream,
};
use tokio::net::TcpStream;

use super::host_key::{HostKeyQuestion, Recorded};
use super::icmm_key;
use super::known_hosts::{self, Verdict};
use super::said::{self, ONLINE, REPORT, Said, icmm_retry_once};
use super::transport::{
    AddKeyError, AgentPipes, BoxFuture, ConnectError, Progress, Refusal, Session, Transport,
};
use crate::agent::{Line, next_line};
use crate::engine::preflight::{self, Needs};
use crate::engine::remote::{self, Outcome, Place};
use crate::engine::{Bundle, Engine, selfcheck_error};
use crate::platforms::store::tilde;
use crate::wire::commands::MAX_LINE_BYTES;
use crate::wire::types::{ConnectFailure, ConnectFix, ConnectStep, Upload};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A keepalive every 15 s, and the link is dead after 3 go unanswered; the
/// inactivity timeout breaks a write stalled on a dead link.
const KEEPALIVE: Duration = Duration::from_secs(15);
const KEEPALIVE_MAX: usize = 3;
const INACTIVITY: Duration = Duration::from_secs(90);
/// sshd's MaxAuthTries is 6; stay under it.
const MAX_KEYS: usize = 5;
const PIPE_BYTES: usize = 1 << 20;
/// The preflight waits on `quota` for up to 10 s, after the login shell.
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(60);
/// The whole upload and install, over a slow link.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPLOAD_CHUNK: usize = 256 * 1024;
/// Signing in with the password and adding the key, after the login shell.
const ADD_KEY_TIMEOUT: Duration = Duration::from_secs(60);
const ADD_KEY_SH: &str = include_str!("add_key.sh");
/// The add script's last line once the key is in `authorized_keys`.
const KEY_ADDED: &str = "icmm:key-added";
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// How long an agent that ended before its first line has for its stderr to
/// arrive in full.
const STDERR_GRACE: Duration = Duration::from_secs(1);
/// What an exec the host refused says, as its last line.
const REFUSED: &str = "the host refused to run the command";

/// One host on the way to the platform, and how to sign in to it.
#[derive(Clone, Debug)]
pub struct SshHop {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// The key to sign in with; `None` tries the ssh-agent's keys, then
    /// `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` and ICMM's key.
    pub identity_file: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// The key to sign in with; `None` tries the ssh-agent's keys, then
    /// `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` and ICMM's key.
    pub identity_file: Option<PathBuf>,
    /// The hosts to go through first, in order (`ProxyJump`).
    pub jump: Vec<SshHop>,
}

impl SshTarget {
    /// Every host a connect signs in to, the login host last.
    fn route(&self) -> Vec<SshHop> {
        let mut route = self.jump.clone();
        route.push(SshHop {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            identity_file: self.identity_file.clone(),
        });
        route
    }
}

/// Where a sign-in finds this computer's keys.
#[derive(Clone, Debug)]
pub struct Keys {
    /// `~/.ssh`: the usual key files, and ICMM's key.
    pub folder: PathBuf,
    /// Whether to ask the running ssh-agent for its keys.
    pub agent: bool,
}

impl Default for Keys {
    fn default() -> Keys {
        let home = std::env::home_dir().unwrap_or_default();
        Keys {
            folder: home.join(".ssh"),
            agent: true,
        }
    }
}

/// Runs the engine's agent over SSH, from `<data folder>/engine/<key>/`,
/// installing the engine there first when it's missing.
#[derive(Clone)]
pub struct Ssh {
    target: SshTarget,
    known_hosts: Vec<PathBuf>,
    engine: Engine,
    /// On the host; a leading `~/` is the remote home.
    data_folder: String,
    /// Whether a trusted key's line is hashed; `None` asks `ssh -G`.
    hash_names: Option<bool>,
    keys: Keys,
    /// The platform's name, as sentences name it; its login host until it's
    /// `named`.
    name: String,
    /// Every deadline's length, when it isn't each one's own.
    limit: Option<Duration>,
}

impl Ssh {
    pub fn new(
        target: SshTarget,
        known_hosts: Vec<PathBuf>,
        engine: impl Into<Engine>,
        data_folder: &str,
    ) -> Ssh {
        Ssh {
            name: target.host.clone(),
            target,
            known_hosts,
            engine: engine.into(),
            data_folder: data_folder.to_owned(),
            hash_names: None,
            keys: Keys::default(),
            limit: None,
        }
    }

    /// Each of its deadlines is `limit`, rather than its own: reaching a
    /// host, a keepalive's interval and a dead link's inactivity, the
    /// preflight, the install, adding a key, and an ended agent's stderr.
    pub fn waiting_up_to(self, limit: Duration) -> Ssh {
        Ssh {
            limit: Some(limit),
            ..self
        }
    }

    /// The deadline `own`, or the one it waits up to instead.
    fn deadline(&self, own: Duration) -> Duration {
        self.limit.unwrap_or(own)
    }

    /// Names the platform in what its failures say.
    pub fn named(self, name: impl Into<String>) -> Ssh {
        Ssh {
            name: name.into(),
            ..self
        }
    }

    /// Host `hop` on the route as a sentence names it: the platform for its
    /// login host, a jump host by its own name.
    fn at(&self, hop: usize) -> &str {
        match self.target.jump.get(hop) {
            Some(jump) => &jump.host,
            None => &self.name,
        }
    }

    /// Finds this computer's keys in `keys`, not `~/.ssh` and the ssh-agent.
    pub fn with_keys(self, keys: Keys) -> Ssh {
        Ssh { keys, ..self }
    }

    fn icmm_key_file(&self) -> PathBuf {
        self.keys.folder.join(icmm_key::NAME)
    }

    /// Hashes the names of the keys it trusts, or not, whatever `ssh -G` says.
    pub fn hashing_names(self, hashed: bool) -> Ssh {
        Ssh {
            hash_names: Some(hashed),
            ..self
        }
    }
}

/// A stream an SSH session runs over: a TCP connection, or a tunnel
/// through the jump host before.
trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

impl Transport for Ssh {
    fn open(&self, progress: Progress) -> BoxFuture<'_, Result<Box<dyn Session>, ConnectError>> {
        Box::pin(async move {
            let engine = self
                .engine
                .bundle()
                .await
                .map_err(|e| ConnectError::fatal(said::no_bundle(e, &self.name)))?;
            progress(ConnectStep::SigningIn, None);
            let (handle, through) = self.dial().await?;
            Ok(Box::new(SshSession {
                handle,
                _through: through,
                ssh: self.clone(),
                engine,
                progress,
            }) as Box<dyn Session>)
        })
    }

    fn icmm_key(&self) -> Option<PathBuf> {
        Some(self.icmm_key_file())
    }

    fn hops(&self) -> usize {
        self.target.jump.len() + 1
    }

    fn data_folder(&self) -> String {
        self.data_folder.clone()
    }

    fn add_key<'a>(
        &'a self,
        hop: usize,
        password: &'a str,
    ) -> BoxFuture<'a, Result<PathBuf, AddKeyError>> {
        Box::pin(async move {
            let within = self.deadline(ADD_KEY_TIMEOUT);
            tokio::time::timeout(within, self.add_icmm_key(hop, password))
                .await
                .unwrap_or_else(|_| {
                    Err(AddKeyError::Failed(ConnectError::transient(Said::new(
                        format!("Adding ICMM’s key to {} took too long.", self.at(hop)),
                        said::busy(false),
                    ))))
                })
        })
    }

    fn with_key(&self, hop: usize, file: &Path) -> Option<Box<dyn Transport>> {
        let mut ssh = self.clone();
        let target = &mut ssh.target;
        match target.jump.get_mut(hop) {
            Some(jump) => jump.identity_file = Some(file.to_owned()),
            None => target.identity_file = Some(file.to_owned()),
        }
        Some(Box::new(ssh))
    }
}

fn unreachable(said: Said) -> ConnectError {
    ConnectError::transient(said.fix(ConnectFix::EditPlatform)).because(ConnectFailure::Unreachable)
}

impl Ssh {
    /// Signs in to each host on the route in turn, each reached through a
    /// tunnel from the one before. Answers the login host's session, and the
    /// jump hosts' that carry it.
    async fn dial(&self) -> Result<(Handle<Client>, Vec<Handle<Client>>), ConnectError> {
        let route = self.target.route();
        let last = route.len() - 1;
        let (mut handle, through) = self.reach(&route, last).await?;
        self.sign_in(&mut handle, &route[last], last).await?;
        Ok((handle, through))
    }

    /// Reaches host `last` on `route` through the ones before it, each signed
    /// in to with keys. Answers its session, not yet signed in to, and the
    /// sessions that carry it.
    async fn reach(
        &self,
        route: &[SshHop],
        last: usize,
    ) -> Result<(Handle<Client>, Vec<Handle<Client>>), ConnectError> {
        let first = &route[0];
        let (host, port) = (&first.host, first.port);
        let unanswered = |details: String| {
            unreachable(
                Said::new(
                    format!("ICMM couldn’t reach {}.", self.name),
                    format!(
                        "{ONLINE}. Some clusters need a VPN from off campus. If the login host or \
                         port changed, edit the platform."
                    ),
                )
                .details(details),
            )
        };
        let connect = TcpStream::connect((host.as_str(), port));
        let within = self.deadline(CONNECT_TIMEOUT);
        let tcp = tokio::time::timeout(within, connect)
            .await
            .map_err(|_| {
                let waited = within.as_secs();
                unanswered(format!("{host}:{port} didn’t answer in {waited} s"))
            })?
            .map_err(|e| unanswered(format!("{host}:{port} · {e}")))?;
        let mut stream: Box<dyn Stream> = Box::new(tcp);
        let mut through = Vec::new();
        for (index, hop) in route.iter().enumerate() {
            let mut handle = self.handshake(hop, stream).await?;
            if index == last {
                return Ok((handle, through));
            }
            self.sign_in(&mut handle, hop, index).await?;
            let next = &route[index + 1];
            let tunnel = handle.channel_open_direct_tcpip(
                next.host.clone(),
                next.port.into(),
                "127.0.0.1",
                0,
            );
            let waited = within.as_secs();
            let tunnel_failed = |details: String| {
                unreachable(
                    Said::new(
                        format!("ICMM couldn’t reach {} through {}.", self.name, hop.host),
                        format!("{ONLINE}. If the route changed, edit the platform."),
                    )
                    .details(details),
                )
            };
            let channel = tokio::time::timeout(within, tunnel)
                .await
                .map_err(|_| {
                    tunnel_failed(format!(
                        "{}:{} didn’t answer {} in {waited} s",
                        next.host, next.port, hop.host
                    ))
                })?
                .map_err(|e| {
                    tunnel_failed(format!("{} → {}:{} · {e}", hop.host, next.host, next.port))
                })?;
            stream = Box::new(channel.into_stream());
            through.push(handle);
        }
        unreachable!("the route reaches host {last}")
    }

    /// Makes ICMM's key when this computer hasn't one, signs in to host `hop`
    /// with `password`, and adds the key to its `~/.ssh/authorized_keys`.
    async fn add_icmm_key(&self, hop: usize, password: &str) -> Result<PathBuf, AddKeyError> {
        let route = self.target.route();
        let failed = |e: ConnectError| AddKeyError::Failed(e);
        let Some(at) = route.get(hop) else {
            return Err(failed(ConnectError::fatal(
                Said::new(
                    format!(
                        "{}’s route no longer has the host that asked for a key.",
                        self.name
                    ),
                    "Edit the platform to fix its route.",
                )
                .details(format!("host {hop} on the way to {}", self.target.host))
                .fix(ConnectFix::EditPlatform)
                .no_retry(),
            )));
        };
        let host = &at.host;
        let named = self.at(hop);
        let file = self.icmm_key_file();
        let made = {
            let file = file.clone();
            tokio::task::spawn_blocking(move || icmm_key::ensure(&file)).await
        };
        let key = made
            .map_err(std::io::Error::other)
            .and_then(|made| made)
            .map_err(|e| failed(ConnectError::fatal(cant_make_key(&file, &e))))?;
        let (mut handle, _through) = self.reach(&route, hop).await.map_err(failed)?;
        let broke = |e: russh::Error| {
            failed(ConnectError::transient(
                Said::new(
                    format!("Signing in to {named} with your password failed."),
                    "Retry. If it keeps failing, use a key you have instead.",
                )
                .details(e.to_string()),
            ))
        };
        // The password goes only to a host that says it takes one; some
        // stop saying so once one is wrong.
        let signed_in = match handle.authenticate_none(at.user.as_str()).await {
            Ok(AuthResult::Success) => true,
            Ok(AuthResult::Failure {
                remaining_methods, ..
            }) if remaining_methods.contains(&MethodKind::Password) => false,
            Ok(AuthResult::Failure { .. }) => return Err(AddKeyError::NoPassword),
            Err(e) => {
                dropped(&handle, named, host).map_err(failed)?;
                return Err(broke(e));
            }
        };
        if !signed_in {
            match handle.authenticate_password(&at.user, password).await {
                Ok(AuthResult::Success) => {}
                Ok(AuthResult::Failure {
                    partial_success: true,
                    ..
                }) => return Err(failed(asks_for_more(named, host, "password"))),
                Ok(AuthResult::Failure { .. }) => {
                    dropped(&handle, named, host).map_err(failed)?;
                    return Err(AddKeyError::WrongPassword);
                }
                Err(e) => {
                    dropped(&handle, named, host).map_err(failed)?;
                    return Err(broke(e));
                }
            }
        }
        let command = format!(
            "exec sh -s -- {}",
            remote::sh_quote(&icmm_key::public_line(&key))
        );
        let (out, errors) = run(&handle, named, &command, ADD_KEY_SH.as_bytes())
            .await
            .map_err(failed)?;
        if !out.lines().any(|line| line.trim().ends_with(KEY_ADDED)) {
            return Err(failed(ConnectError::fatal(
                Said::new(
                    format!("ICMM couldn’t add its key to ~/.ssh/authorized_keys on {named}."),
                    "Check that you can write to ~/.ssh there, or send the public key to your \
                     cluster’s admins.",
                )
                .details(last_line(&errors).unwrap_or_default()),
            )));
        }
        tracing::info!("added ICMM's key {} to {host}", tilde(&file));
        Ok(file)
    }

    /// The SSH handshake with `hop` over `stream`, its host key checked.
    async fn handshake(
        &self,
        hop: &SshHop,
        stream: Box<dyn Stream>,
    ) -> Result<Handle<Client>, ConnectError> {
        let (host, port) = (&hop.host, hop.port);
        let seen = Arc::new(Mutex::new(None));
        let client = Client {
            host: host.clone(),
            port,
            known_hosts: self.known_hosts.clone(),
            seen: seen.clone(),
        };
        client::connect_stream(Arc::new(self.config(hop)), stream, client)
            .await
            .map_err(|e| match seen.lock().unwrap().take() {
                Some((v, key)) if v != Verdict::Trusted => self.host_key_error(hop, v, key),
                _ => no_ssh(&self.name, format!("{host}:{port} · {e}")),
            })
    }

    fn config(&self, hop: &SshHop) -> client::Config {
        let mut config = client::Config {
            keepalive_interval: Some(self.deadline(KEEPALIVE)),
            keepalive_max: KEEPALIVE_MAX,
            inactivity_timeout: Some(self.deadline(INACTIVITY)),
            nodelay: true,
            ..Default::default()
        };
        // Ask first for the key types known_hosts has for this host, as
        // OpenSSH does, so a host recorded only by its RSA key isn't unknown.
        let mut keys = known_hosts::recorded_algorithms(&self.known_hosts, &hop.host, hop.port);
        let rest: Vec<_> = config
            .preferred
            .key
            .iter()
            .filter(|a| !keys.contains(a))
            .cloned()
            .collect();
        keys.extend(rest);
        config.preferred.key = keys.into();
        config
    }

    /// Why the handshake with `hop` stopped at its key, with the question
    /// for the user when there's one they can answer.
    fn host_key_error(&self, hop: &SshHop, verdict: Verdict, key: PublicKey) -> ConnectError {
        let at = known_hosts::lookup_name(&hop.host, hop.port);
        let question = |recorded: Option<Recorded>| HostKeyQuestion {
            host: hop.host.clone(),
            port: hop.port,
            key: key.clone(),
            file: self.known_hosts.first().cloned().unwrap_or_default(),
            hashed: self.hash_names,
            recorded,
        };
        let changed = |recorded: &PublicKey, file: &Path, line: usize| {
            ConnectError::fatal(
                Said::new(
                    format!("{at} has a different host key."),
                    "If you didn’t expect it, ask your cluster’s admins before you go on.",
                )
                .details(format!(
                    "{} line {line} · {} {}",
                    tilde(file),
                    known_hosts::algorithm_name(recorded),
                    known_hosts::fingerprint(recorded)
                ))
                .no_retry(),
            )
            .because(ConnectFailure::HostKeyChanged)
        };
        match verdict {
            Verdict::Trusted => no_ssh(
                &self.name,
                format!("{at} · failed after its host key was accepted"),
            ),
            // Known by another key type only: a host that stopped offering
            // the type on record, or someone who never had it. Either way,
            // the key the user trusted isn't the one presented.
            Verdict::Unknown {
                other_types_known: true,
            } if let Some((path, line, recorded)) =
                known_hosts::other_type_on_record(&self.known_hosts, &hop.host, hop.port, &key) =>
            {
                changed(&recorded, &path, line).about(question(Some(Recorded {
                    key: recorded,
                    file: path,
                    line,
                })))
            }
            Verdict::Unknown { .. } => {
                let error = ConnectError::fatal(
                    Said::new(
                        format!(
                            "ICMM couldn’t check {}’s host key: this computer has no known_hosts \
                             file to keep it in.",
                            self.name
                        ),
                        "Sign in once with ssh in Terminal and answer yes, then retry.",
                    )
                    .details(format!("ssh {}@{}", hop.user, hop.host)),
                )
                .because(ConnectFailure::HostKeyUnknown);
                // With no known_hosts to add it to, there's nothing to ask.
                match self.known_hosts.first() {
                    Some(_) => error.about(question(None)),
                    None => error,
                }
            }
            Verdict::Changed {
                path,
                line,
                recorded,
            } => changed(&recorded, &path, line).about(question(Some(Recorded {
                key: recorded,
                file: path,
                line,
            }))),
            Verdict::Revoked => ConnectError::fatal(
                Said::new(
                    format!(
                        "This computer is set never to trust the key {} showed.",
                        hop.host
                    ),
                    "Someone marked that key as unsafe. Check the platform’s login host, and ask \
                     your cluster’s admins before you go on.",
                )
                .details(format!(
                    "@revoked in known_hosts · {} {}",
                    known_hosts::algorithm_name(&key),
                    known_hosts::fingerprint(&key)
                ))
                .fix(ConnectFix::EditPlatform)
                .no_retry(),
            )
            .because(ConnectFailure::HostKeyRevoked),
        }
    }

    /// Signs in to `hop`, the `index`th host on the route, with each key in
    /// turn: the ssh-agent's, then key files.
    async fn sign_in(
        &self,
        handle: &mut Handle<Client>,
        hop: &SshHop,
        index: usize,
    ) -> Result<(), ConnectError> {
        let SshHop {
            host,
            user,
            identity_file,
            ..
        } = hop;
        let named = self.at(index);
        let rsa_hash = match handle.best_supported_rsa_hash().await {
            Ok(Some(hash)) => hash,
            // The server named no signature algorithms: SHA-2 still, never SHA-1.
            Ok(None) | Err(_) => Some(HashAlg::Sha512),
        };
        let mut tried = Vec::new();
        // What the host said it takes, after the last key it refused.
        let mut methods = None;
        // With a key file named, the agent may only sign with that key.
        let wanted = identity_file.as_deref().and_then(public_key_of);
        let agent = match self.keys.agent {
            true => agent().await,
            false => None,
        };
        if let Some(mut agent) = agent {
            for (key, name) in agent_keys(&mut agent).await {
                let unwanted = wanted
                    .as_ref()
                    .is_some_and(|w| w.key_data() != key.key_data());
                if tried.len() >= MAX_KEYS
                    || unwanted
                    || (identity_file.is_some() && wanted.is_none())
                {
                    continue;
                }
                tried.push(name);
                let hash = if key.algorithm().is_rsa() {
                    rsa_hash
                } else {
                    None
                };
                let result = handle
                    .authenticate_publickey_with(user, key, hash, &mut agent)
                    .await;
                match result {
                    Ok(AuthResult::Success) => return Ok(()),
                    Ok(AuthResult::Failure {
                        partial_success: true,
                        ..
                    }) => return Err(asks_for_more(named, host, "key")),
                    Ok(AuthResult::Failure {
                        remaining_methods, ..
                    }) => {
                        dropped(handle, named, host)?;
                        methods = Some(remaining_methods);
                    }
                    // The agent couldn't sign with it: try the next.
                    Err(_) => dropped(handle, named, host)?,
                }
            }
        }
        let files = match identity_file {
            Some(file) => vec![file.clone()],
            None => self.usual_key_files(),
        };
        let mut notes = Vec::new();
        for file in files {
            if tried.len() >= MAX_KEYS || !file.exists() {
                continue;
            }
            if public_key_file(&file).is_some() {
                notes.push(format!(
                    "{} is a public key, and no running ssh-agent holds its private half",
                    file.display()
                ));
                continue;
            }
            let key = match russh::keys::load_secret_key(&file, None) {
                Ok(key) => key,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    notes.push(format!(
                        "{} needs its passphrase: add it to ssh-agent with `ssh-add`",
                        file.display()
                    ));
                    continue;
                }
                Err(e) => {
                    notes.push(format!("couldn’t read {}: {e}", file.display()));
                    continue;
                }
            };
            tried.push(tilde(&file));
            let hash = if key.algorithm().is_rsa() {
                rsa_hash
            } else {
                None
            };
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            match handle.authenticate_publickey(user, key).await {
                Ok(AuthResult::Success) => return Ok(()),
                Ok(AuthResult::Failure {
                    partial_success: true,
                    ..
                }) => return Err(asks_for_more(named, host, "key")),
                Ok(AuthResult::Failure {
                    remaining_methods, ..
                }) => {
                    dropped(handle, named, host)?;
                    methods = Some(remaining_methods);
                }
                Err(e) => {
                    dropped(handle, named, host)?;
                    notes.push(format!("{e}"));
                }
            }
        }
        // With no key refused, the host hasn't said what it takes yet.
        let methods = match methods {
            Some(methods) => methods,
            None => match handle.authenticate_none(user.as_str()).await {
                Ok(AuthResult::Success) => return Ok(()),
                Ok(AuthResult::Failure {
                    remaining_methods, ..
                }) => remaining_methods,
                Err(_) => {
                    dropped(handle, named, host)?;
                    Vec::new().as_slice().into()
                }
            },
        };
        let icmm_key_refused = identity_file.as_deref() == Some(self.icmm_key_file().as_path());
        let (reason, mut details) = match either(&tried) {
            Some(keys) => (
                format!("{named} didn’t accept the sign-in as {user}."),
                vec![host.clone(), format!("tried {keys}")],
            ),
            None => (
                format!(
                    "{named} didn’t accept the sign-in as {user}: this computer has no SSH key \
                     to offer."
                ),
                vec![host.clone()],
            ),
        };
        details.extend(notes);
        let said = Said::new(
            reason,
            "ICMM can make a key and add it to the cluster, using your password once.",
        )
        .details(details.join(" · "))
        .fix(ConnectFix::SetUpKey);
        Err(ConnectError::fatal(said)
            .because(ConnectFailure::SignIn)
            .refused(Refusal {
                hop: index,
                host: host.clone(),
                user: user.clone(),
                tried,
                password: methods.contains(&MethodKind::Password),
                icmm_key_refused,
            }))
    }

    /// The key files tried when the platform names none: OpenSSH's usual
    /// ones, then ICMM's.
    fn usual_key_files(&self) -> Vec<PathBuf> {
        ["id_ed25519", "id_ecdsa", "id_rsa", icmm_key::NAME]
            .iter()
            .map(|name| self.keys.folder.join(name))
            .collect()
    }
}

/// A sign-in cut off by a dropped connection says nothing about the key:
/// that's worth trying again, unlike a refusal. russh reports it as a
/// failure, so a closed session is what tells the two apart.
fn dropped(handle: &Handle<Client>, named: &str, host: &str) -> Result<(), ConnectError> {
    if handle.is_closed() {
        return Err(ConnectError::transient(
            Said::new(
                format!("The connection to {named} dropped while ICMM signed in."),
                format!("{ONLINE}, then retry."),
            )
            .details(host),
        ));
    }
    Ok(())
}

/// A host that took the key or password, then asked for a second step (a
/// code, say), which ICMM can't give (ADR-0012).
fn asks_for_more(named: &str, host: &str, what: &str) -> ConnectError {
    ConnectError::fatal(
        Said::new(
            format!("{named} asks for more than a {what}, such as a code from your phone."),
            "ICMM can’t sign in where that’s needed, so retrying won’t help. Use this computer \
             instead, or ask your cluster’s admins for a way in with a key alone.",
        )
        .details(format!("{host} accepted the {what}, then asked for more"))
        .fix(ConnectFix::UseThisComputer)
        .no_retry(),
    )
}

/// The SSH session with `named` failed, `details` saying how.
fn no_ssh(named: &str, details: String) -> ConnectError {
    ConnectError::transient(
        Said::new(
            format!("ICMM couldn’t open an SSH connection to {named}."),
            format!(
                "{ONLINE}, then retry. If it keeps failing, send the details to your cluster’s \
                 admins."
            ),
        )
        .details(details),
    )
    .because(ConnectFailure::Unreachable)
}

/// ICMM's key couldn't be made at `file`.
pub fn cant_make_key(file: &Path, e: &dyn std::fmt::Display) -> Said {
    Said::new(
        format!("ICMM couldn’t make its key at {}.", tilde(file)),
        "Check that you can write to ~/.ssh. If a file that isn’t a key is already there, move \
         it aside, then retry.",
    )
    .details(e.to_string())
}

/// "a", "a or b", "a, b or c"; `None` for none.
fn either(items: &[String]) -> Option<String> {
    match items {
        [] => None,
        [one] => Some(one.clone()),
        [rest @ .., last] => Some(format!("{} or {last}", rest.join(", "))),
    }
}

/// The public half of a key file: the file itself when it's a public key
/// (whose private half only an agent holds, as 1Password and Secretive
/// do), its `.pub` beside it, or the key itself, which OpenSSH keeps readable
/// even when the key is encrypted.
fn public_key_of(file: &Path) -> Option<PublicKey> {
    if let Some(key) = public_key_file(file) {
        return Some(key);
    }
    let mut pub_file = file.as_os_str().to_owned();
    pub_file.push(".pub");
    if let Some(key) = std::fs::read_to_string(pub_file)
        .ok()
        .and_then(|text| PublicKey::from_openssh(text.trim()).ok())
    {
        return Some(key);
    }
    let key = russh::keys::ssh_key::PrivateKey::read_openssh_file(file).ok()?;
    Some(key.public_key().clone())
}

/// The key in `file`, when it's a public key.
fn public_key_file(file: &Path) -> Option<PublicKey> {
    let text = std::fs::read_to_string(file).ok()?;
    PublicKey::from_openssh(text.trim()).ok()
}

type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// The running ssh-agent, if any: `SSH_AUTH_SOCK`, or on Windows the
/// OpenSSH agent's pipe, then Pageant. None is normal.
async fn agent() -> Option<Agent> {
    #[cfg(unix)]
    {
        AgentClient::connect_env()
            .await
            .ok()
            .map(AgentClient::dynamic)
    }
    #[cfg(windows)]
    {
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Some(a.dynamic());
        }
        AgentClient::connect_pageant()
            .await
            .ok()
            .map(AgentClient::dynamic)
    }
}

/// The agent's plain keys, each with how to name it.
async fn agent_keys(agent: &mut Agent) -> Vec<(PublicKey, String)> {
    let identities = agent.request_identities().await.unwrap_or_default();
    identities
        .into_iter()
        .filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, comment } => {
                let name = if comment.is_empty() {
                    format!("an ssh-agent {} key", known_hosts::algorithm_name(&key))
                } else {
                    format!("ssh-agent key {comment}")
                };
                Some((key, name))
            }
            _ => None,
        })
        .collect()
}

struct Client {
    host: String,
    port: u16,
    known_hosts: Vec<PathBuf>,
    /// The verdict on the key the host presented, and the key.
    seen: Arc<Mutex<Option<(Verdict, PublicKey)>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // No certificate types are offered, so none comes.
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        let verdict = known_hosts::verdict(&self.known_hosts, &self.host, self.port, key);
        let trusted = verdict == Verdict::Trusted;
        *self.seen.lock().unwrap() = Some((verdict, key.clone()));
        Ok(trusted)
    }
}

struct SshSession {
    /// The login host's session.
    handle: Handle<Client>,
    /// The jump hosts' sessions, which carry it.
    _through: Vec<Handle<Client>>,
    ssh: Ssh,
    /// The engine it runs.
    engine: Bundle,
    progress: Progress,
}

/// A command running on its own channel, its output pumped into pipes.
struct Exec {
    stdout: DuplexStream,
    stderr: DuplexStream,
    write: russh::ChannelWriteHalf<client::Msg>,
    pump: tokio::task::JoinHandle<()>,
}

/// Runs `command` on its own channel of `handle`'s session.
async fn exec(handle: &Handle<Client>, command: &str) -> Result<Exec, russh::Error> {
    let channel = handle.channel_open_session().await?;
    channel.exec(true, command.as_bytes()).await?;
    let (mut read, write) = channel.split();
    let (stdout, mut stdout_in) = tokio::io::duplex(PIPE_BYTES);
    let (stderr, mut stderr_in) = tokio::io::duplex(PIPE_BYTES);
    let pump = tokio::spawn(async move {
        while let Some(message) = read.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if stdout_in.write_all(&data).await.is_err() {
                        break;
                    }
                }
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    let _ = stderr_in.write_all(&data).await;
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    tracing::info!("the command exited with status {exit_status}")
                }
                ChannelMsg::Failure => {
                    let _ = stderr_in.write_all(format!("{REFUSED}\n").as_bytes()).await;
                    break;
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    });
    Ok(Exec {
        stdout,
        stderr,
        write,
        pump,
    })
}

/// Runs `command` on `handle`'s session with `input` on its stdin, and
/// answers its stdout and stderr once it ends. `named` is the host, as a
/// failure names it.
async fn run(
    handle: &Handle<Client>,
    named: &str,
    command: &str,
    input: &[u8],
) -> Result<(String, String), ConnectError> {
    let failed = |e: russh::Error| {
        ConnectError::transient(
            Said::new(
                format!("The SSH connection to {named} failed."),
                format!("{ONLINE}, then retry."),
            )
            .details(e.to_string()),
        )
    };
    let Exec {
        stdout,
        stderr,
        write,
        pump,
    } = exec(handle, command).await.map_err(failed)?;
    let output = tokio::spawn(read_both(stdout, stderr));
    write.make_writer().write_all(input).await.ok();
    write.eof().await.map_err(failed)?;
    let output = output.await.unwrap_or_default();
    pump.abort();
    let _ = write.close().await;
    Ok(output)
}

impl SshSession {
    async fn exec(&self, command: &str) -> Result<Exec, russh::Error> {
        exec(&self.handle, command).await
    }

    async fn run(&self, command: &str, input: &[u8]) -> Result<(String, String), ConnectError> {
        run(&self.handle, &self.ssh.name, command, input).await
    }

    /// The platform's name, as sentences name it.
    fn name(&self) -> &str {
        &self.ssh.name
    }

    /// The platform's Data folder, where the engine goes.
    fn place(&self) -> Place<'_> {
        Place {
            platform: &self.ssh.name,
            folder: &self.ssh.data_folder,
        }
    }

    /// The preflight: the bytes already uploaded, or why the engine can't go here.
    async fn preflight(&self) -> Result<u64, ConnectError> {
        let (engine, data_folder) = (&self.engine, &self.ssh.data_folder);
        let command = remote::preflight_command(data_folder, &engine.sha256);
        let script = remote::preflight_script();
        let within = self.ssh.deadline(PREFLIGHT_TIMEOUT);
        let (report, errors) = tokio::time::timeout(within, self.run(&command, script.as_bytes()))
            .await
            .map_err(|_| {
                ConnectError::transient(Said::new(
                    format!("Checking {} for ICMM’s engine took too long.", self.name()),
                    said::busy(false),
                ))
            })??;
        if !report.contains("uname=") {
            return Err(ConnectError::fatal(
                Said::new(
                    format!(
                        "ICMM couldn’t make a folder for its engine in {data_folder} on {}.",
                        self.name()
                    ),
                    "Check that you can write there, or edit the platform to choose another \
                     Data folder.",
                )
                .details(last_line(&errors).unwrap_or_default())
                .fix(ConnectFix::EditPlatform),
            )
            .because(ConnectFailure::DataFolder));
        }
        let needs = Needs {
            target: engine.target(),
            bytes: engine.install_bytes(),
        };
        preflight::verdict(&report, &needs, &self.place())
            .map_err(|refusal| ConnectError::fatal(refusal.said).because(refusal.kind))
    }

    /// Uploads the archive from `offset` into the install script, and answers
    /// how the install ended.
    async fn upload(&self, offset: u64) -> Result<Outcome, ConnectError> {
        let (engine, data_folder) = (&self.engine, &self.ssh.data_folder);
        let failed = |e: &dyn std::fmt::Display| {
            ConnectError::transient(
                Said::new(
                    format!("The engine’s upload to {} stopped.", self.name()),
                    format!("{ONLINE}, then retry. The upload picks up where it stopped."),
                )
                .details(e.to_string()),
            )
        };
        let command = remote::install_command(data_folder, engine, offset);
        let Exec {
            stdout,
            stderr,
            write,
            pump,
        } = self.exec(&command).await.map_err(|e| failed(&e))?;
        let output = tokio::spawn(read_both(stdout, stderr));
        let mut archive = tokio::fs::File::open(&engine.archive)
            .await
            .map_err(|e| failed(&e))?;
        archive
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| failed(&e))?;
        let total = engine.archive_bytes;
        let mut sent = offset;
        let mut shown = tokio::time::Instant::now();
        let report = |sent: u64| {
            let upload = Upload {
                sent: sent as i64,
                total: total as i64,
            };
            (self.progress)(ConnectStep::InstallingEngine, Some(upload));
        };
        report(sent);
        let mut writer = write.make_writer();
        let mut chunk = vec![0; UPLOAD_CHUNK];
        loop {
            let n = archive.read(&mut chunk).await.map_err(|e| failed(&e))?;
            if n == 0 {
                break;
            }
            // A write that fails means the install ended early; it says why.
            if writer.write_all(&chunk[..n]).await.is_err() {
                break;
            }
            sent += n as u64;
            if shown.elapsed() >= PROGRESS_EVERY {
                report(sent);
                shown = tokio::time::Instant::now();
            }
        }
        report(sent);
        let _ = write.eof().await;
        let (said, errors) = output.await.unwrap_or_default();
        pump.abort();
        let _ = write.close().await;
        let outcome = remote::outcome(&said);
        if outcome == Outcome::Unknown {
            tracing::warn!("the engine install said: {said} {errors}");
        }
        Ok(outcome)
    }
}

impl Session for SshSession {
    fn start_agent(&self) -> BoxFuture<'_, Result<AgentPipes, ConnectError>> {
        Box::pin(async move {
            let (engine, data_folder) = (&self.engine, &self.ssh.data_folder);
            let command = remote::agent_command(data_folder, &engine.key, engine.interpreter());
            let Exec {
                stdout,
                stderr,
                write,
                pump,
            } = self.exec(&command).await.map_err(|e| {
                ConnectError::transient(
                    Said::new(
                        format!("ICMM couldn’t start its engine on {}.", self.name()),
                        format!("{ONLINE}, then retry."),
                    )
                    .details(e.to_string()),
                )
            })?;
            let stdin = write.make_writer();
            let guard = ChannelGuard {
                write: Some(write),
                pump,
            };
            // The login shell may print before the engine's line.
            let mut stdout = BufReader::new(stdout);
            loop {
                match next_line(&mut stdout, MAX_LINE_BYTES).await {
                    Ok(Line::Complete(line)) => {
                        // What the login shell printed without a newline may
                        // come first.
                        let line = String::from_utf8_lossy(&line);
                        let line = line.trim();
                        if line.ends_with(remote::READY) {
                            break;
                        }
                        if line.ends_with(remote::MISSING) {
                            return Err(ConnectError::no_engine(format!(
                                "{}/{}/{}",
                                data_folder.trim_end_matches('/'),
                                crate::engine::FOLDER,
                                engine.key
                            )));
                        }
                        tracing::info!("the login shell said: {line}");
                    }
                    Ok(Line::TooLong) => {}
                    Ok(Line::End) | Err(_) => {
                        drop(guard);
                        let grace = self.ssh.deadline(STDERR_GRACE);
                        let said = tokio::time::timeout(grace, read_all(stderr))
                            .await
                            .unwrap_or_default();
                        return Err(ConnectError::transient(self.didnt_start(last_line(&said)))
                            .because(ConnectFailure::Engine));
                    }
                }
            }
            Ok(AgentPipes {
                stdout: Box::new(stdout),
                stdin: Box::new(stdin),
                stderr: Box::new(stderr),
                guard: Box::new(guard),
            })
        })
    }

    fn install_engine(&self) -> BoxFuture<'_, Result<(), ConnectError>> {
        Box::pin(async move {
            let install = async {
                // A damaged upload goes again once, from the start.
                for _ in 0..2 {
                    let offset = self.preflight().await?;
                    match self.upload(offset).await? {
                        Outcome::Installed => return Ok(()),
                        Outcome::Again => continue,
                        Outcome::Failed { why, detail } => {
                            return Err(install_failure(&why, &detail, &self.place()));
                        }
                        Outcome::Unknown => {
                            return Err(ConnectError::transient(Said::new(
                                format!(
                                    "ICMM’s engine install on {} stopped before it finished.",
                                    self.name()
                                ),
                                "Retry. It picks up where it stopped.",
                            )));
                        }
                    }
                }
                Err(ConnectError::transient(Said::new(
                    "ICMM’s engine arrived damaged twice.",
                    "Check the connection (a VPN or proxy can change files on the way), then \
                     retry.",
                )))
            };
            tokio::time::timeout(self.ssh.deadline(INSTALL_TIMEOUT), install)
                .await
                .map_err(|_| {
                    ConnectError::transient(Said::new(
                        format!("Installing ICMM’s engine on {} took too long.", self.name()),
                        "The cluster may be busy. Retry; the upload picks up where it stopped.",
                    ))
                })?
        })
    }

    fn set_engine_aside(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let (engine, data_folder) = (&self.engine, &self.ssh.data_folder);
            let command = remote::set_aside_command(data_folder, &engine.key);
            let (out, errors) = self
                .run(&command, &[])
                .await
                .map_err(|e| e.said.details.unwrap_or(e.said.reason))?;
            match out
                .lines()
                .any(|line| line.trim().ends_with(remote::SET_ASIDE))
            {
                true => Ok(()),
                false => Err(last_line(&errors).unwrap_or("it didn’t say why").to_owned()),
            }
        })
    }

    fn closed(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            while !self.handle.is_closed() {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        })
    }

    fn probe(&self) -> BoxFuture<'_, bool> {
        // `send_ping` is Ok even when the session died, so check both.
        Box::pin(async move { self.handle.send_ping().await.is_ok() && !self.handle.is_closed() })
    }
}

impl SshSession {
    /// The engine's start that ended before its first line, with the last
    /// line it wrote, if any.
    fn didnt_start(&self, line: Option<&str>) -> Said {
        let name = self.name();
        let said = match line {
            // A folder the cluster won't run programs from (`noexec`).
            Some(line) if line.contains("Permission denied") => Said::new(
                format!(
                    "{name} wouldn’t run ICMM’s engine from {}.",
                    self.ssh.data_folder
                ),
                "Some clusters don’t let programs run from every folder. Ask your cluster’s \
                 admins where they can, and send them the details. Then edit the platform to \
                 move its Data folder there.",
            )
            .fix(ConnectFix::EditPlatform),
            Some(line) if line.contains(REFUSED) => Said::new(
                format!("{name} refused to run ICMM’s engine."),
                "Ask your cluster’s admins whether SSH sign-ins may run programs, and send them \
                 the details.",
            ),
            _ => Said::new(
                format!("ICMM’s engine didn’t start on {name}."),
                format!(
                    "Retry once. If it fails again, send the details to your cluster’s admins, or \
                     {REPORT}."
                ),
            )
            .fix(ConnectFix::Report),
        };
        said.details(line.unwrap_or_default())
    }
}

/// What an install script's `icmm:failed <why> <detail>` means for the user.
fn install_failure(why: &str, detail: &str, at: &Place) -> ConnectError {
    let platform = at.platform;
    let full = || {
        ConnectError::fatal(
            Said::new(
                format!(
                    "{} ran out of space while ICMM installed its engine.",
                    at.sentence_start()
                ),
                "Free up some space there, then retry. Your cluster’s admins can say how big your \
                 quota is.",
            )
            .details(detail),
        )
        .because(ConnectFailure::NoSpace)
    };
    match why {
        "busy" => ConnectError::transient(Said::new(
            format!("Another copy of ICMM is installing the engine on {platform}."),
            "Retry in a minute, once it’s done.",
        )),
        "space" => full(),
        "unpack" if detail.contains("quota") || detail.contains("No space") => full(),
        "cut" => ConnectError::transient(
            Said::new(
                format!("The engine’s upload to {platform} was cut off."),
                "Retry: the next connect picks up where it stopped.",
            )
            .details(detail),
        ),
        "selfcheck" => ConnectError::fatal(
            Said::new(
                format!("ICMM’s engine on {platform} didn’t pass its self-check."),
                icmm_retry_once(),
            )
            .details(selfcheck_error(detail))
            .fix(ConnectFix::Report),
        )
        .because(ConnectFailure::Engine),
        _ => ConnectError::transient(
            Said::new(
                format!("ICMM couldn’t install its engine on {platform}."),
                "Retry once. If it fails again, send the details to your cluster’s admins.",
            )
            .details(match detail {
                "" => why.to_owned(),
                detail => format!("{why}: {detail}"),
            }),
        ),
    }
}

async fn read_all(mut stream: impl AsyncRead + Unpin) -> String {
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).into_owned()
}

async fn read_both(stdout: DuplexStream, stderr: DuplexStream) -> (String, String) {
    tokio::join!(read_all(stdout), read_all(stderr))
}

fn last_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty())
}

/// Closes the agent's channel when dropped: its stdin ends and it exits.
struct ChannelGuard {
    write: Option<russh::ChannelWriteHalf<client::Msg>>,
    pump: tokio::task::JoinHandle<()>,
}

impl Drop for ChannelGuard {
    fn drop(&mut self) {
        self.pump.abort();
        if let Some(write) = self.write.take() {
            tokio::spawn(async move {
                let _ = write.eof().await;
                let _ = write.close().await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::LineEnding;
    use russh::keys::{Algorithm, PrivateKey};

    /// A test that isn't about the link's limits sets them beyond reach: no
    /// keepalive goes unanswered, and no quiet link is dropped.
    #[test]
    fn waiting_up_to_a_limit_sets_the_links_keepalive_and_inactivity() {
        const NEVER: Duration = Duration::from_secs(365 * 24 * 60 * 60);
        let target = SshTarget {
            host: "login.example.edu".into(),
            port: 22,
            user: "tester".into(),
            identity_file: None,
            jump: Vec::new(),
        };
        let engines = crate::engine::Engines::from_fn(|_| Err("none".into()));
        let engine = Engine::Find(engines, crate::engine::CLUSTER_TARGET);
        let ssh = Ssh::new(target.clone(), Vec::new(), engine, "data").waiting_up_to(NEVER);

        let config = ssh.config(&target.route()[0]);

        assert_eq!(config.keepalive_interval, Some(NEVER));
        assert_eq!(config.inactivity_timeout, Some(NEVER));
    }

    /// 1Password and Secretive name a key by its public half, and hold the
    /// private one in their agent.
    #[test]
    fn a_public_key_file_names_the_agent_key_to_use() {
        let dir = tempfile::tempdir().unwrap();
        let mut rng = rand::rng();
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let private = dir.path().join("id_ed25519");
        key.write_openssh_file(&private, LineEnding::LF).unwrap();
        let public = dir.path().join("agent_only.pub");
        std::fs::write(&public, key.public_key().to_openssh().unwrap()).unwrap();

        let wanted = public_key_of(&public).unwrap();
        assert_eq!(wanted.key_data(), key.public_key().key_data());
        assert!(public_key_file(&public).is_some());
        assert!(public_key_file(&private).is_none());
        assert_eq!(
            public_key_of(&private).unwrap().key_data(),
            key.public_key().key_data()
        );
    }
}
