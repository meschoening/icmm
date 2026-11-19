//! The connection to the active platform: its transports (a local child
//! process, or an SSH exec channel), the agent on it, and the supervisor that
//! keeps it up and publishes its state (ADR-0009).
//!
//! The supervisor opens a session, starts an agent and says hello, installing
//! the platform's engine first when the agent's start finds it missing, and
//! publishes each step of the way (`ConnectStep`) with when it began and
//! ended. Once connected it pings the agent every 15 s: an agent that misses
//! a ping or exits is replaced on the same session at once, and a lost link
//! is reconnected after 5, 10, 20, 40, then 60 s, each wait published with
//! its attempt and cut short by a wake or by Retry now. It gives up only when
//! trying again can't help (a refused sign-in, a host key that doesn't match,
//! an engine on another protocol, a Data folder the agent refuses), and a
//! first connect that fails isn't retried. A failure says what it needs
//! (`ConnectFailure`). A hello that names a **Hand-over** (ADR-0020) isn't
//! one: the supervisor asks the same agent again after the wait it names,
//! for as long as it names one.
//!
//! Each agent holds the runs database's change feed for its session,
//! subscribed before the app hears it's connected, so no change falls between
//! what the app reads then and the feed. A replacement resumes from the last
//! change seen, and the changes made meanwhile follow (ADR-0009).
//!
//! A host key known_hosts has never seen is a question for the user, not a
//! failure: the connect publishes it and waits, however long, for Trust or
//! Disconnect. Trusting records the key, then connects again from the start,
//! so the server's login grace time never runs out under the prompt, and the
//! prompt ends with its connect.
//!
//! A first connect that no key gets through asks for a key the same way
//! (ADR-0012): the password the user gives adds ICMM's key to the host that
//! refused, once, and the connect goes on with that key, its Signing in
//! counted from the press. On a platform that connected from this computer
//! before, a refused key is a failure, which Set up a key turns into the same
//! question; nothing is held open while either waits.

pub mod host_key;
pub mod icmm_key;
pub mod known_hosts;
pub mod local;
pub mod platform;
pub mod policy;
pub mod said;
pub mod ssh;
pub mod transport;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, BufReader};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::agent::{Agent, CallError, Line, Pushed, StartError, method_timeout, next_line};
use crate::platforms::store::tilde;
use crate::wire::commands::{MAX_LINE_BYTES, PROTOCOL_VERSION};
use crate::wire::types::{
    Changes, ConnectFailure, ConnectFix, ConnectStep, ConnectionState, ConnectionStatus,
    DataFolderData, DataFolderProblem, FeedPosition, HostKey, KeyOffer, KeyQuestion, Retry,
    StepTime, SubscribeChangesParams, Subscription, Upload,
};
use host_key::HostKeyQuestion;
use policy::{Kind, backoff};
use said::{REPORT, Said, icmm_retry_once};
use transport::{AddKeyError, AgentPipes, ConnectError, Progress, Refusal, Session, Transport};

pub struct Timings {
    pub ping_every: Duration,
    pub ping_timeout: Duration,
    /// How long the link has to answer a probe after the machine wakes.
    pub probe_timeout: Duration,
    /// How long opening a channel and starting the agent on it may take.
    pub start_timeout: Duration,
    /// How long a new agent has to answer `hello`, then `subscribe_changes`.
    pub hello_timeout: Duration,
    pub subscribe_timeout: Duration,
    /// How long an ended agent's stderr gets to arrive in full.
    pub stderr_grace: Duration,
    /// A value in −1…1 that spreads each reconnect wait.
    pub jitter: fn() -> f64,
    /// The time now, in Unix milliseconds.
    pub now: fn() -> i64,
}

impl Default for Timings {
    fn default() -> Timings {
        Timings {
            ping_every: Duration::from_secs(15),
            ping_timeout: method_timeout("ping"),
            probe_timeout: Duration::from_secs(5),
            start_timeout: START_TIMEOUT,
            hello_timeout: method_timeout("hello"),
            subscribe_timeout: method_timeout("subscribe_changes"),
            stderr_grace: Duration::from_secs(1),
            jitter: || fastrand::f64() * 2.0 - 1.0,
            now: unix_ms,
        }
    }
}

/// The wall clock, in Unix milliseconds: what the app shows times by.
pub fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Takes each line the agent writes to stderr.
pub type LineSink = dyn Fn(&[u8]) + Send + Sync;

pub struct Options {
    pub app_version: String,
    pub timings: Timings,
    /// Called with each new state.
    pub on_state: Box<dyn Fn(ConnectionState) + Send + Sync>,
    /// Called with what each event of the change feed says changed.
    pub on_changes: Box<dyn Fn(Changes) + Send + Sync>,
    /// Called with each event of the other subscriptions a page holds, such
    /// as `watch_start`'s.
    pub on_event: Box<dyn Fn(Pushed) + Send + Sync>,
    /// Wake signals; `None` watches the wall clock for them.
    pub wakes: Option<mpsc::Receiver<()>>,
    pub agent_log: Box<LineSink>,
    /// Whether the platform connected from this computer before: then a
    /// refused key fails, rather than asking for one.
    pub connected_before: bool,
    /// Whether the user just forgot the host's old key: the first host key
    /// this connect asks about is its new one.
    pub forgot: bool,
}

/// ICMM's key, added to the host at `hop` on the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyAdded {
    pub hop: usize,
    pub file: PathBuf,
}

/// Why the password didn't add ICMM's key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddKeyFailure {
    /// The connect isn't asking for a key, or no longer.
    Stale,
    /// The host refused the password: the question stays.
    WrongPassword,
    /// The host takes no password: the question shows ICMM's public key now,
    /// to add by hand.
    NoPassword,
    /// Adding failed some other way, and so did the connect, saying why.
    Failed,
}

/// The key question a connect waits on, and which host on the way it's about.
#[derive(Debug, Clone)]
pub struct KeyAsk {
    pub hop: usize,
    pub question: KeyQuestion,
}

/// What the user says to a connect that waits on them.
enum Answer {
    /// Trust the host key with this fingerprint.
    Trust(String),
    /// Ask for a key, from a refused sign-in.
    SetUpKey(oneshot::Sender<bool>),
    /// Add ICMM's key with this password.
    AddKey(
        Zeroizing<String>,
        oneshot::Sender<Result<KeyAdded, AddKeyFailure>>,
    ),
}

impl Answer {
    /// Answers a question the connect isn't asking.
    fn stale(self) {
        match self {
            Answer::Trust(_) => {}
            Answer::SetUpKey(reply) => {
                let _ = reply.send(false);
            }
            Answer::AddKey(_, reply) => {
                let _ = reply.send(Err(AddKeyFailure::Stale));
            }
        }
    }
}

/// A supervised connection. Dropping it leaves the supervisor running;
/// `disconnect` ends it.
pub struct Connection {
    /// Taken by `disconnect`.
    task: Mutex<Option<JoinHandle<()>>>,
    publisher: Arc<Publisher>,
    agent: watch::Receiver<Option<Arc<Agent>>>,
    /// Ends a reconnect's wait.
    retry: Arc<Notify>,
    /// What the user says to a connect that waits on them.
    answers: mpsc::UnboundedSender<Answer>,
}

impl Connection {
    /// Starts connecting to the platform named `platform` through `transport`.
    pub fn start(platform: String, transport: impl Transport, options: Options) -> Connection {
        let local = transport.local();
        let publisher = Arc::new(Publisher {
            on: said::on(&platform, local),
            platform,
            local,
            forgot: options.forgot.into(),
            on_state: options.on_state,
            clock: options.timings.now,
            now: Mutex::new(Now::default()),
        });
        let retry = Arc::new(Notify::new());
        let (answers_tx, answers) = mpsc::unbounded_channel();
        let (agent_tx, agent) = watch::channel(None);
        let wakes = options
            .wakes
            .unwrap_or_else(|| watch_the_wall_clock(WAKE_TICK));
        let supervisor = Supervisor {
            transport: Box::new(transport),
            app_version: options.app_version,
            timings: options.timings,
            publisher: publisher.clone(),
            agent: agent_tx,
            wakes,
            agent_log: Arc::from(options.agent_log),
            on_changes: options.on_changes,
            on_event: options.on_event,
            feed: None,
            failures: 0,
            attempts: 0,
            retry: retry.clone(),
            answers,
            connected_before: options.connected_before,
            added: None,
            heard_at: None,
        };
        Connection {
            task: Mutex::new(Some(tokio::spawn(supervisor.run()))),
            publisher,
            agent,
            retry,
            answers: answers_tx,
        }
    }

    /// Trusts the host key the connect waits on, if its fingerprint is
    /// `fingerprint`: the connect records it and goes on. Answers whether
    /// the connect was waiting on that key.
    pub fn trust_host_key(&self, fingerprint: &str) -> bool {
        let asked = self
            .publisher
            .now
            .lock()
            .unwrap()
            .host_key
            .as_ref()
            .is_some_and(|q| {
                q.recorded.is_none() && known_hosts::fingerprint(&q.key) == fingerprint
            });
        asked
            && self
                .answers
                .send(Answer::Trust(fingerprint.to_owned()))
                .is_ok()
    }

    /// The key question the connect waits on, if any.
    pub fn key_question(&self) -> Option<KeyAsk> {
        self.publisher.now.lock().unwrap().key_question.clone()
    }

    /// Turns a refused sign-in into the key question. Answers whether the
    /// connect asks it now.
    pub async fn set_up_key(&self) -> bool {
        let stopped = {
            let now = self.publisher.now.lock().unwrap();
            let refused = matches!(
                now.failure,
                Some(ConnectFailure::SignIn | ConnectFailure::KeyRefused)
            );
            now.key_question.is_some() || (now.status == ConnectionStatus::Failed && refused)
        };
        if !stopped {
            return false;
        }
        let (reply, answer) = oneshot::channel();
        if self.answers.send(Answer::SetUpKey(reply)).is_err() {
            return false;
        }
        answer.await.unwrap_or(false)
    }

    /// Adds ICMM's key to the host the key question is about, with
    /// `password`; the connect then goes on with the key. The password is
    /// dropped once it's been used.
    pub async fn add_key(&self, password: Zeroizing<String>) -> Result<KeyAdded, AddKeyFailure> {
        if self.key_question().is_none() {
            return Err(AddKeyFailure::Stale);
        }
        let (reply, answer) = oneshot::channel();
        if self.answers.send(Answer::AddKey(password, reply)).is_err() {
            return Err(AddKeyFailure::Stale);
        }
        answer.await.unwrap_or(Err(AddKeyFailure::Stale))
    }

    /// The host key the connect stopped at: one it waits on, or a changed
    /// one it failed on.
    pub fn host_key(&self) -> Option<HostKeyQuestion> {
        self.publisher.now.lock().unwrap().host_key.clone()
    }

    /// Ends a reconnect's wait, so the next attempt starts now. An attempt
    /// already under way isn't affected, nor is the wait after it.
    pub fn retry_now(&self) {
        self.retry.notify_waiters();
    }

    /// The agent while connected, or `None`.
    pub fn agent(&self) -> Option<Arc<Agent>> {
        self.agent.borrow().clone()
    }

    /// Resolves once the supervisor has stopped, by `disconnect` or a panic:
    /// it holds the agent's sender, which drops with it.
    pub async fn stopped(&self) {
        let mut agent = self.agent.clone();
        while agent.changed().await.is_ok() {}
    }

    /// Calls an agent method, sending it again when the policy allows
    /// (`policy::retry`): a write keeps its params, and so its `request_key`.
    pub async fn call<P: Serialize + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        kind: Kind,
        params: Option<&P>,
        timeout: Duration,
    ) -> Result<R, CallError> {
        let started = tokio::time::Instant::now();
        let mut retries = 0;
        loop {
            let result = match self.agent() {
                Some(agent) => agent.call(method, params, timeout).await,
                None => Err(CallError::NotConnected),
            };
            let error = match result {
                Ok(reply) => return Ok(reply),
                Err(error) => error,
            };
            match policy::retry(kind, retries, &error, started.elapsed()) {
                Some(wait) => {
                    tracing::info!("sending {method} again in {wait:?} after {error:?}");
                    tokio::time::sleep(wait).await;
                    // The wait (or a delayed wake) may have used up the
                    // write's remaining retry window.
                    if policy::retry(kind, retries, &error, started.elapsed()).is_none() {
                        return Err(error);
                    }
                    retries += 1;
                }
                None => return Err(error),
            }
        }
    }

    /// Ends the connection and its agent, whatever it's doing: connecting,
    /// connected or reconnecting.
    pub async fn disconnect(&self) {
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
            self.publisher.not_connected();
        }
    }
}

struct Publisher {
    platform: String,
    /// Whether the platform is this computer.
    local: bool,
    /// Where the platform is, in a sentence: "on McKelvey HPC".
    on: String,
    /// Whether the next host key asked about replaces one the user forgot.
    forgot: std::sync::atomic::AtomicBool,
    on_state: Box<dyn Fn(ConnectionState) + Send + Sync>,
    clock: fn() -> i64,
    now: Mutex<Now>,
}

/// What was published last.
struct Now {
    status: ConnectionStatus,
    since: i64,
    reason: Option<String>,
    /// While failed, the rest of what it says.
    said: Option<Said>,
    steps: Vec<StepTime>,
    failure: Option<ConnectFailure>,
    retry: Option<Retry>,
    host_key: Option<HostKeyQuestion>,
    key_question: Option<KeyAsk>,
    /// The engine's version, from the hello of the agent that connected last.
    engine: Option<String>,
    /// While reconnecting, when the lost connection's agent was last heard.
    heard_at: Option<i64>,
}

impl Default for Now {
    fn default() -> Now {
        Now {
            status: ConnectionStatus::Connecting,
            since: 0,
            reason: None,
            said: None,
            steps: Vec::new(),
            failure: None,
            retry: None,
            host_key: None,
            key_question: None,
            engine: None,
            heard_at: None,
        }
    }
}

impl Now {
    /// A new status starts its time; the same one keeps it.
    fn status(&mut self, status: ConnectionStatus, at: i64) {
        if self.status != status {
            self.since = at;
        }
        self.status = status;
    }

    fn end_step(&mut self, at: i64) {
        if let Some(step) = self.steps.last_mut() {
            step.ended_at.get_or_insert(at);
        }
    }
}

impl Publisher {
    /// A connect begins.
    fn connecting(&self) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!("{}: connecting", self.platform);
        *now = Now {
            since: at,
            ..Now::default()
        };
        self.send(&now, None);
    }

    /// Another attempt begins: its steps replace the last one's.
    fn new_attempt(&self) {
        self.now.lock().unwrap().steps.clear();
    }

    /// Where the connect is now, under the status and reason it had. The step
    /// before it ends.
    fn step(&self, step: ConnectStep, upload: Option<Upload>) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        let under_way = now
            .steps
            .last()
            .is_some_and(|s| s.step == step && s.ended_at.is_none());
        if !under_way {
            tracing::info!("{}: {step}", self.platform);
            now.end_step(at);
            now.steps.push(StepTime {
                step,
                started_at: at,
                ended_at: None,
            });
        }
        self.send(&now, upload);
    }

    /// A hello named a hand-over: the `checking` under way was handing over.
    /// The hellos after it that name one too leave it so.
    fn handing_over(&self) {
        let mut now = self.now.lock().unwrap();
        let checking = now
            .steps
            .last_mut()
            .filter(|t| t.ended_at.is_none() && t.step == ConnectStep::Checking);
        let Some(step) = checking else { return };
        tracing::info!("{}: {}", self.platform, ConnectStep::HandingOver);
        step.step = ConnectStep::HandingOver;
        self.send(&now, None);
    }

    fn connected(&self, engine: String) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!("{}: connected", self.platform);
        now.engine = Some(engine);
        now.end_step(at);
        now.status(ConnectionStatus::Connected, at);
        now.reason = None;
        now.said = None;
        now.failure = None;
        now.retry = None;
        self.send(&now, None);
    }

    /// The connect failed, and won't be tried again; its steps stop where it
    /// did. A changed host key comes with the old one on record.
    fn failed(&self, said: Said, failure: ConnectFailure, host_key: Option<HostKeyQuestion>) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!(
            "{}: failed ({failure}): {} {} [{}]",
            self.platform,
            said.reason,
            said.next_step,
            said.details.as_deref().unwrap_or_default()
        );
        now.end_step(at);
        now.status(ConnectionStatus::Failed, at);
        now.reason = Some(said.reason.clone());
        now.said = Some(said);
        now.failure = Some(failure);
        now.retry = None;
        now.host_key = host_key;
        now.key_question = None;
        self.send(&now, None);
    }

    /// The connect waits for the user to trust a host key, or not.
    fn asking(&self, question: HostKeyQuestion) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!(
            "{}: asking whether to trust {}'s {} key {}",
            self.platform,
            known_hosts::lookup_name(&question.host, question.port),
            known_hosts::algorithm_name(&question.key),
            known_hosts::fingerprint(&question.key),
        );
        now.end_step(at);
        now.status(ConnectionStatus::Connecting, at);
        now.reason = None;
        now.said = None;
        now.failure = None;
        now.retry = None;
        now.host_key = Some(question);
        self.send(&now, None);
    }

    /// The connect waits for the user to add a key, or choose one.
    fn asking_for_key(&self, ask: KeyAsk) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!(
            "{}: asking for a key that {} accepts",
            self.platform,
            ask.question.host
        );
        now.end_step(at);
        now.status(ConnectionStatus::Connecting, at);
        now.reason = None;
        now.said = None;
        now.failure = None;
        now.retry = None;
        now.host_key = None;
        now.key_question = Some(ask);
        self.send(&now, None);
    }

    /// ICMM's key is in, added from `started`: signing in starts over, and
    /// counts from then.
    fn key_added(&self, started: i64) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        now.key_question = None;
        now.steps = vec![StepTime {
            step: ConnectStep::AddingKey,
            started_at: started,
            ended_at: Some(at),
        }];
        self.send(&now, None);
    }

    /// The user trusted the key: signing in starts over.
    fn trusted(&self) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        now.host_key = None;
        self.forgot
            .store(false, std::sync::atomic::Ordering::Relaxed);
        now.steps = vec![StepTime {
            step: ConnectStep::SigningIn,
            started_at: at,
            ended_at: None,
        }];
        self.send(&now, None);
    }

    /// The connection was lost, or an attempt to get it back failed with
    /// `failure`. Each try publishes its own steps; until one runs, there
    /// are none.
    fn reconnecting(
        &self,
        reason: String,
        failure: Option<ConnectFailure>,
        retry: Retry,
        heard_at: Option<i64>,
    ) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!(
            "{}: reconnecting (attempt {}): {reason}",
            self.platform,
            retry.attempt
        );
        now.steps.clear();
        now.status(ConnectionStatus::Reconnecting, at);
        now.reason = Some(reason);
        now.said = None;
        now.failure = failure;
        now.retry = Some(retry);
        now.host_key = None;
        now.key_question = None;
        now.heard_at = heard_at;
        self.send(&now, None);
    }

    /// The wait is over: the attempt runs.
    fn trying(&self) {
        let mut now = self.now.lock().unwrap();
        if let Some(retry) = &mut now.retry {
            retry.at = None;
        }
        self.send(&now, None);
    }

    fn not_connected(&self) {
        let at = (self.clock)();
        let mut now = self.now.lock().unwrap();
        tracing::info!("{}: not connected", self.platform);
        now.status(ConnectionStatus::NotConnected, at);
        now.reason = None;
        now.said = None;
        now.steps.clear();
        now.failure = None;
        now.retry = None;
        now.host_key = None;
        now.key_question = None;
        self.send(&now, None);
    }

    fn send(&self, now: &Now, upload: Option<Upload>) {
        let said = now.said.as_ref();
        let forgot = self.forgot.load(std::sync::atomic::Ordering::Relaxed);
        (self.on_state)(ConnectionState {
            status: now.status,
            // The platforms manager knows the saved platform's id.
            platform_id: None,
            platform: Some(self.platform.clone()),
            reason: now.reason.clone(),
            next_step: said.map(|s| s.next_step.clone()),
            details: said.and_then(|s| s.details.clone()),
            fixes: said.map(|s| s.fixes.clone()).unwrap_or_default(),
            can_retry: said.is_some_and(|s| s.can_retry),
            since: Some(now.since),
            steps: now.steps.clone(),
            upload,
            failure: now.failure,
            retry: now.retry.clone(),
            host_key: now.host_key.as_ref().map(|q| HostKey {
                // Only a key asked about, not a changed one, replaces a forgotten one.
                forgot: forgot && q.recorded.is_none(),
                ..q.wire()
            }),
            key_question: now.key_question.as_ref().map(|k| k.question.clone()),
            engine_version: match now.status {
                ConnectionStatus::Connected => now.engine.clone(),
                _ => None,
            },
            heard_at: match now.status {
                ConnectionStatus::Reconnecting => now.heard_at,
                _ => None,
            },
        });
    }
}

/// How an agent's service ended.
enum AgentEnd {
    /// Trying again can't help.
    Fatal(Said, ConnectFailure),
    /// It never started serving.
    NotStarted(Said, ConnectFailure),
    Hung,
    Exited,
    LinkLost(String),
}

struct Supervisor {
    transport: Box<dyn Transport>,
    app_version: String,
    timings: Timings,
    publisher: Arc<Publisher>,
    agent: watch::Sender<Option<Arc<Agent>>>,
    wakes: mpsc::Receiver<()>,
    agent_log: Arc<LineSink>,
    on_changes: Box<dyn Fn(Changes) + Send + Sync>,
    on_event: Box<dyn Fn(Pushed) + Send + Sync>,
    /// The last change the feed handed on, which the next agent resumes from.
    feed: Option<FeedPosition>,
    /// Failures since the agent last answered a ping: they set the backoff.
    failures: u32,
    /// Attempts since the connection was last lost: what the app shows.
    attempts: i64,
    /// Ends a reconnect's wait.
    retry: Arc<Notify>,
    /// What the user says to a connect that waits on them.
    answers: mpsc::UnboundedReceiver<Answer>,
    /// Whether the platform connected from this computer before.
    connected_before: bool,
    /// The host ICMM's key was just added to, until a sign-in gets through.
    added: Option<usize>,
    /// When the agent last answered or pushed: what the pages read is as of then once the
    /// connection is lost.
    heard_at: Option<i64>,
}

impl Supervisor {
    async fn run(mut self) {
        self.publisher.connecting();
        let mut connected_once = false;
        // After a key is added, its sign-in counts from the press.
        let mut keep_steps = false;
        loop {
            if !std::mem::take(&mut keep_steps) {
                self.publisher.new_attempt();
            }
            let session = match self.transport.open(self.progress()).await {
                Ok(session) => {
                    self.added = None;
                    session
                }
                Err(ConnectError {
                    host_key: Some(question),
                    ..
                }) if question.recorded.is_none() => match self.ask(*question).await {
                    Ok(()) => continue,
                    Err((reason, kind)) => return self.publisher.failed(reason, kind, None),
                },
                Err(ConnectError {
                    sign_in: Some(refusal),
                    said,
                    ..
                }) => {
                    let before = self.connected_before || connected_once;
                    match self.ask_for_key(*refusal, *said, before).await {
                        Ok(()) => {
                            keep_steps = true;
                            continue;
                        }
                        Err((reason, kind)) => return self.publisher.failed(reason, kind, None),
                    }
                }
                Err(e) if e.fatal || !connected_once => {
                    return self
                        .publisher
                        .failed(*e.said, e.kind, e.host_key.map(|q| *q));
                }
                Err(e) => {
                    self.reconnect(e.said.reason, Some(e.kind), false).await;
                    continue;
                }
            };
            let mut first = true;
            let (lost, failure) = loop {
                if !first {
                    self.publisher.new_attempt();
                }
                first = false;
                let reason = match self.serve(&*session).await {
                    AgentEnd::Fatal(reason, kind) => {
                        return self.publisher.failed(reason, kind, None);
                    }
                    AgentEnd::NotStarted(said, kind) if !connected_once => {
                        return self.publisher.failed(said, kind, None);
                    }
                    AgentEnd::NotStarted(said, kind) => break (said.reason, Some(kind)),
                    // Not a try that failed: the connection ended.
                    AgentEnd::LinkLost(reason) => break (reason, None),
                    AgentEnd::Hung => format!("ICMM’s engine {} stopped answering.", self.on()),
                    AgentEnd::Exited => format!("ICMM’s engine {} stopped.", self.on()),
                };
                connected_once = true;
                self.reconnect(reason, None, true).await;
            };
            connected_once = true;
            self.reconnect(lost, failure, false).await;
        }
    }

    /// Where the platform is, in a sentence: "on McKelvey HPC".
    fn on(&self) -> &str {
        &self.publisher.on
    }

    fn platform(&self) -> &str {
        &self.publisher.platform
    }

    /// Asks the user whether to trust a host key, and waits as long as they
    /// take; Disconnect ends the wait with the connection. Trusted, the key
    /// is recorded. Fails only when it can't be.
    async fn ask(&mut self, question: HostKeyQuestion) -> Result<(), (Said, ConnectFailure)> {
        let fingerprint = known_hosts::fingerprint(&question.key);
        // An answer to a question asked before isn't one to this.
        while let Ok(answer) = self.answers.try_recv() {
            answer.stale();
        }
        self.publisher.asking(question.clone());
        loop {
            match self.next_answer().await {
                Answer::Trust(answer) if answer == fingerprint => break,
                answer => answer.stale(),
            }
        }
        self.publisher.trusted();
        question.trust().await.map_err(|e| {
            let file = tilde(&question.file);
            let said = Said::new(
                format!(
                    "ICMM couldn’t save {}’s host key in {file}.",
                    self.platform()
                ),
                format!("Check that you can write to {file}, then retry."),
            )
            .details(e.to_string());
            (said, ConnectFailure::Other)
        })
    }

    /// The user's next answer, however long they take. With the connection
    /// gone, none can come.
    async fn next_answer(&mut self) -> Answer {
        match self.answers.recv().await {
            Some(answer) => answer,
            None => std::future::pending().await,
        }
    }

    /// A sign-in no key got through. A platform that connected before fails,
    /// until the user sets up a key; then, as on a first connect, it asks
    /// for one, and waits until ICMM's key is added. Fails when adding does,
    /// or when the key it just added is refused too.
    async fn ask_for_key(
        &mut self,
        refusal: Refusal,
        refused: Said,
        before: bool,
    ) -> Result<(), (Said, ConnectFailure)> {
        let host = refusal.host.clone();
        // The login host is the platform; a jump host before it, itself.
        let named = match refusal.hop + 1 == self.hops() {
            true => self.platform().to_owned(),
            false => host.clone(),
        };
        if self.added.take() == Some(refusal.hop) && refusal.icmm_key_refused {
            let said = Said::new(
                format!("{named} has ICMM’s key in ~/.ssh/authorized_keys, but didn’t accept it."),
                "Some clusters ignore that file when others can change your home folder. Ask your \
                 cluster’s admins, and send them the details.",
            )
            .details(format!("{host} · ~/.ssh/authorized_keys"));
            return Err((said, ConnectFailure::Other));
        }
        while let Ok(answer) = self.answers.try_recv() {
            answer.stale();
        }
        let again = before && refusal.icmm_key_refused;
        if before {
            let (said, kind) = match again {
                true => (
                    Said::new(
                        format!("{named} no longer accepts the key ICMM made for it."),
                        "It may have been removed from the cluster. ICMM can add it again, using \
                         your password once.",
                    )
                    .details(format!("{host} · ~/.ssh/{}", icmm_key::NAME))
                    .fix(ConnectFix::AddKeyAgain),
                    ConnectFailure::KeyRefused,
                ),
                false => (refused, ConnectFailure::SignIn),
            };
            self.publisher.failed(said, kind, None);
            loop {
                match self.next_answer().await {
                    Answer::SetUpKey(reply) => {
                        let _ = reply.send(true);
                        break;
                    }
                    answer => answer.stale(),
                }
            }
        }
        let mut ask = KeyAsk {
            hop: refusal.hop,
            question: self.key_question(&refusal, again).await?,
        };
        self.publisher.asking_for_key(ask.clone());
        loop {
            let (password, reply) = match self.next_answer().await {
                Answer::AddKey(password, reply) => (password, reply),
                Answer::SetUpKey(reply) => {
                    let _ = reply.send(true);
                    continue;
                }
                answer => {
                    answer.stale();
                    continue;
                }
            };
            let started = (self.timings.now)();
            let added = self.transport.add_key(refusal.hop, &password).await;
            drop(password);
            match added {
                Ok(file) => {
                    if let Some(transport) = self.transport.with_key(refusal.hop, &file) {
                        self.transport = transport;
                    }
                    self.added = Some(refusal.hop);
                    self.publisher.key_added(started);
                    let _ = reply.send(Ok(KeyAdded {
                        hop: refusal.hop,
                        file,
                    }));
                    // Nothing asks any more: what came during the add is stale.
                    while let Ok(answer) = self.answers.try_recv() {
                        answer.stale();
                    }
                    return Ok(());
                }
                Err(AddKeyError::WrongPassword) => {
                    tracing::info!("{host} didn't accept the password");
                    let _ = reply.send(Err(AddKeyFailure::WrongPassword));
                }
                Err(AddKeyError::NoPassword) => {
                    let public = self.icmm_public_key().await;
                    let _ = reply.send(Err(AddKeyFailure::NoPassword));
                    ask.question.password = false;
                    ask.question.public_key = Some(public?);
                    self.publisher.asking_for_key(ask.clone());
                }
                Err(AddKeyError::Failed(e)) => {
                    let _ = reply.send(Err(AddKeyFailure::Failed));
                    while let Ok(answer) = self.answers.try_recv() {
                        answer.stale();
                    }
                    // A host before it that refused its key isn't this
                    // question's to fix: the reason names it.
                    let (kind, mut said) = match e.kind {
                        ConnectFailure::SignIn | ConnectFailure::KeyRefused => {
                            (ConnectFailure::Other, e.said)
                        }
                        kind => (kind, e.said),
                    };
                    // Nor is setting up a key, which this question was.
                    said.fixes.retain(|f| *f != ConnectFix::SetUpKey);
                    return Err((*said, kind));
                }
            }
        }
    }

    /// The key question for `refusal`: what to offer, and where the host
    /// takes no password, ICMM's public key to add by hand. Fails when that
    /// key can't be made.
    async fn key_question(
        &self,
        refusal: &Refusal,
        again: bool,
    ) -> Result<KeyQuestion, (Said, ConnectFailure)> {
        let file = self.transport.icmm_key();
        let made = match file.clone() {
            Some(file) => tokio::task::spawn_blocking(move || icmm_key::read(&file).is_some())
                .await
                .unwrap_or(false),
            None => false,
        };
        let public_key = match refusal.password {
            true => None,
            false => Some(self.icmm_public_key().await?),
        };
        Ok(KeyQuestion {
            host: refusal.host.clone(),
            user: refusal.user.clone(),
            tried: refusal.tried.clone(),
            offer: match (again, made) {
                (true, _) => KeyOffer::AddAgain,
                (false, true) => KeyOffer::Add,
                (false, false) => KeyOffer::Make,
            },
            password: refusal.password,
            public_key,
        })
    }

    /// ICMM's key's public line, made when this computer hasn't the key.
    async fn icmm_public_key(&self) -> Result<String, (Said, ConnectFailure)> {
        let Some(file) = self.transport.icmm_key() else {
            return Err((*transport::without_key().said, ConnectFailure::Other));
        };
        let at = file.clone();
        let made = tokio::task::spawn_blocking(move || icmm_key::ensure(&at)).await;
        match made.map_err(std::io::Error::other).and_then(|made| made) {
            Ok(key) => Ok(icmm_key::public_line(&key)),
            Err(e) => Err((ssh::cant_make_key(&file, &e), ConnectFailure::Other)),
        }
    }

    /// How many hosts a connect signs in to, the login host last.
    fn hops(&self) -> usize {
        self.transport.hops()
    }

    /// Publishes why it's reconnecting (with what the try needs, when one
    /// failed) and which attempt comes next, then waits before it: not at
    /// all to replace an agent that failed for the first time, else the
    /// backoff. A wake or Retry now ends the wait.
    async fn reconnect(
        &mut self,
        reason: String,
        failure: Option<ConnectFailure>,
        agent_only: bool,
    ) {
        self.failures += 1;
        self.attempts += 1;
        let attempt = self.attempts;
        let tries = if agent_only {
            self.failures - 1
        } else {
            self.failures
        };
        if tries == 0 {
            let retry = Retry { attempt, at: None };
            return self
                .publisher
                .reconnecting(reason, failure, retry, self.heard_at);
        }
        let wait = backoff(tries, (self.timings.jitter)());
        let at = (self.timings.now)() + wait.as_millis() as i64;
        let retry = Retry {
            attempt,
            at: Some(at),
        };
        self.publisher
            .reconnecting(reason, failure, retry, self.heard_at);
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            Some(()) = self.wakes.recv() => {}
            () = self.retry.notified() => {}
        }
        self.publisher.trying();
    }

    /// Hands the transport's steps to the publisher.
    fn progress(&self) -> Progress {
        let publisher = self.publisher.clone();
        Arc::new(move |step, upload| publisher.step(step, upload))
    }

    /// Starts an agent on `session`, says hello, and watches it until it ends.
    async fn serve(&mut self, session: &dyn Session) -> AgentEnd {
        let AgentPipes {
            stdout,
            stdin,
            stderr,
            guard,
        } = match self.start(session).await {
            Ok(pipes) => pipes,
            Err(end) => return end,
        };
        let mut log = Some(tokio::spawn(copy_lines(stderr, self.agent_log.clone())));
        let agent = Arc::new(Agent::new(stdout, stdin));
        self.publisher.step(ConnectStep::Checking, None);
        // An engine on another wire version, set aside once it has ended.
        let mut mismatched = None;
        let mut hello = agent
            .hello(&self.app_version, self.timings.hello_timeout)
            .await;
        // A newer engine takes the runs over first (ADR-0020): the agent asks
        // the older coordinators to stop, and its hello says so until they
        // have. Asked again, the same agent goes on from there.
        while let Err(StartError::HandOver { retry_after }) = hello {
            self.publisher.handing_over();
            tokio::time::sleep(retry_after).await;
            hello = agent
                .hello(&self.app_version, self.timings.hello_timeout)
                .await;
        }
        let mut end = match hello {
            Ok(hello) => {
                // This computer's host name stays out of the log, which a
                // report carries into a public issue (#505); a cluster's
                // login host shows which cluster answered.
                let on = if self.publisher.local {
                    String::new()
                } else {
                    format!(" on {}", hello.facts.host)
                };
                tracing::info!(
                    "{}: engine {}{on} (protocol {}, {} CPUs, scheduler {})",
                    self.publisher.platform,
                    hello.engine_version,
                    hello.protocol,
                    hello.facts.cpus,
                    hello.facts.scheduler,
                );
                let events = agent.events();
                let subscription = self.subscribe(&agent).await;
                self.agent.send_replace(Some(agent.clone()));
                self.heard_at = Some((self.timings.now)());
                self.publisher.connected(hello.engine_version);
                self.attempts = 0;
                let end = self.watch(&agent, session, events, subscription).await;
                self.agent.send_replace(None);
                end
            }
            Err(StartError::Version { agent }) => {
                let details = format!("wire {agent} · this app wire {PROTOCOL_VERSION}");
                mismatched = Some(agent);
                AgentEnd::Fatal(
                    Said::new(
                        if self.publisher.local {
                            "ICMM on this computer is a different version from this app.".into()
                        } else {
                            format!(
                                "ICMM on {} is a different version from this app.",
                                self.platform()
                            )
                        },
                        "Retry installs the matching engine.",
                    )
                    .details(details),
                    ConnectFailure::Engine,
                )
            }
            Err(StartError::Exited) => {
                // Its stderr says why, once it has all come.
                let line = match log.take() {
                    Some(task) => finish(task, self.timings.stderr_grace).await,
                    None => None,
                };
                let said = Said::new(
                    format!("ICMM’s engine {} stopped before it was ready.", self.on()),
                    icmm_retry_once(),
                )
                .details(line.unwrap_or_default())
                .fix(ConnectFix::Report);
                AgentEnd::NotStarted(said, ConnectFailure::Engine)
            }
            Err(e) => self.unready(e),
        };
        drop(agent);
        drop(guard);
        // What the agent wrote last still reaches the log; its stderr ends
        // with it.
        if let Some(task) = log {
            finish(task, self.timings.stderr_grace).await;
        }
        if let Some(wire) = mismatched {
            // So that a retry installs the engine this app carries: only now
            // the agent is gone, since Windows won't move a running program's
            // folder, and NFS won't remove its open files.
            if let Err(e) = session.set_engine_aside().await {
                tracing::warn!("couldn't set aside the engine on wire {wire}: {e}");
                if let AgentEnd::Fatal(said, _) = &mut end {
                    said.next_step = icmm_retry_once();
                    said.fixes = vec![ConnectFix::Report];
                }
            }
        }
        end
    }

    /// An agent whose hello failed, saying why.
    fn unready(&self, e: StartError) -> AgentEnd {
        let on = self.on();
        let fatal = |said: Said, kind| AgentEnd::Fatal(said, kind);
        let not_started = |said: Said| AgentEnd::NotStarted(said, ConnectFailure::Engine);
        match e {
            StartError::DataFolder(data) => {
                fatal(self.data_folder(data), ConnectFailure::DataFolder)
            }
            StartError::Damaged(detail) => {
                let folder = self.folder();
                fatal(
                    Said::new(
                        format!(
                            "ICMM can’t read the run records in {folder}: runs.db is damaged, or \
                             isn’t ICMM’s."
                        ),
                        format!(
                            "ICMM won’t change it. Edit the platform to choose another Data \
                             folder, or {REPORT}."
                        ),
                    )
                    .details(format!("{} · {detail}", said::within(&folder, "runs.db")))
                    .fix(ConnectFix::EditPlatform)
                    .fix(ConnectFix::Report)
                    .no_retry(),
                    ConnectFailure::DataFolder,
                )
            }
            StartError::Full(free) => fatal(
                Said::new(
                    format!("The Data folder, {}, is full.", self.folder()),
                    "Free up some space there, then retry.",
                )
                .details(
                    free.map(|n| format!("{} free", said::size(n)))
                        .unwrap_or_default(),
                ),
                ConnectFailure::NoSpace,
            ),
            StartError::Busy => not_started(Said::new(
                format!("The run records {on} were busy."),
                "Another copy of ICMM was saving. Retry in a moment.",
            )),
            StartError::Timeout => not_started(
                Said::new(
                    format!("ICMM’s engine {on} took too long to get ready."),
                    said::busy(self.publisher.local),
                )
                .details(format!(
                    "no answer in {} s",
                    self.timings.hello_timeout.as_secs()
                )),
            ),
            StartError::Internal { log_ref, message } => not_started(
                Said::new(
                    format!("ICMM’s engine {on} hit an error while it got ready."),
                    icmm_retry_once(),
                )
                .details(format!("log {log_ref} · {message}"))
                .fix(ConnectFix::Report),
            ),
            StartError::Garbled(error) => not_started(
                Said::new(
                    format!("ICMM’s engine {on} didn’t understand this app."),
                    icmm_retry_once(),
                )
                .details(error)
                .fix(ConnectFix::Report),
            ),
            StartError::Version { .. } | StartError::Exited | StartError::HandOver { .. } => {
                unreachable!("serve says these")
            }
        }
    }

    /// The Data folder, as the user wrote it.
    fn folder(&self) -> String {
        self.transport.data_folder()
    }

    /// A Data folder the agent can't keep its runs database in.
    fn data_folder(&self, data: DataFolderData) -> Said {
        let folder = self.folder();
        let platform = self.platform();
        let such_as = data
            .suggestion
            .as_deref()
            .map(|s| format!(", such as {s}"))
            .unwrap_or_default();
        let storage = data.storage.as_deref().unwrap_or("its storage");
        let admins = "your cluster’s admins can say which.";
        let said = match data.problem {
            DataFolderProblem::Unshared => Said::new(
                format!(
                    "{folder} is on {storage}, which the cluster’s computers that run your fits \
                     can’t reach."
                ),
                format!(
                    "Edit the platform and choose a Data folder on storage they share{such_as}; \
                     {admins}"
                ),
            )
            .no_retry(),
            DataFolderProblem::Locks => Said::new(
                format!("{folder} is on {storage}, where ICMM can’t keep its run records safe."),
                format!(
                    "Several of the cluster’s computers save there at once, and that storage \
                     can’t make them take turns. Edit the platform and choose a Data folder on \
                     other storage{such_as}; {admins}"
                ),
            )
            .no_retry(),
            DataFolderProblem::Newer => Said::new(
                if self.publisher.local {
                    format!("A newer version of ICMM set up {folder} on this computer.")
                } else {
                    format!("A newer version of ICMM set up {folder} on {platform}.")
                },
                "Update ICMM on this computer to use it, or edit the platform to choose another \
                 Data folder.",
            )
            .no_retry(),
            DataFolderProblem::Settings => {
                return Said::new(
                    format!("This version of ICMM can’t read the Platform settings in {folder}."),
                    format!(
                        "A newer version saved them, or they’re damaged. Update ICMM on this \
                         computer; if that doesn’t help, {REPORT}."
                    ),
                )
                .details(data.details)
                .fix(ConnectFix::Report)
                .no_retry();
            }
            DataFolderProblem::ReadOnly => {
                let (here, how) = match self.publisher.local {
                    true if cfg!(target_os = "macos") => (
                        " on this computer",
                        " (Finder › Get Info › Sharing & Permissions)",
                    ),
                    true => (" on this computer", ""),
                    false => ("", ""),
                };
                Said::new(
                    format!("ICMM can’t save run records in {folder}{here}."),
                    format!(
                        "It isn’t allowed to change {}. Check that the folder belongs to \
                         you{how}, or edit the platform to choose another Data folder.",
                        said::within(&folder, "runs.db")
                    ),
                )
            }
        };
        said.details(data.details).fix(ConnectFix::EditPlatform)
    }

    /// Starts an agent on `session`, installing the engine first when the
    /// platform hasn't it.
    async fn start(&self, session: &dyn Session) -> Result<AgentPipes, AgentEnd> {
        let mut installed = false;
        loop {
            self.publisher.step(ConnectStep::Starting, None);
            let within = self.timings.start_timeout;
            let e = match tokio::time::timeout(within, session.start_agent()).await {
                Ok(Ok(pipes)) => return Ok(pipes),
                Ok(Err(e)) => e,
                Err(_) => {
                    return Err(AgentEnd::NotStarted(
                        Said::new(
                            format!("ICMM’s engine {} took too long to start.", self.on()),
                            said::busy(self.publisher.local),
                        )
                        .details(format!("no answer in {} s", within.as_secs())),
                        ConnectFailure::Engine,
                    ));
                }
            };
            if !e.no_engine || installed {
                return Err(match e {
                    e if e.no_engine => AgentEnd::NotStarted(
                        Said {
                            reason: format!(
                                "ICMM’s engine went missing right after it was installed {}.",
                                self.on()
                            ),
                            next_step: match self.publisher.local {
                                true => "Retry once. If it happens again, something on this \
                                         computer is removing ICMM’s files, such as antivirus \
                                         software."
                                    .into(),
                                false => "Retry once. If it happens again, something on the \
                                          cluster is removing files: ask your cluster’s admins."
                                    .into(),
                            },
                            ..*e.said
                        },
                        ConnectFailure::Engine,
                    ),
                    e if e.fatal => AgentEnd::Fatal(*e.said, e.kind),
                    e => AgentEnd::NotStarted(*e.said, e.kind),
                });
            }
            self.publisher.step(ConnectStep::InstallingEngine, None);
            match session.install_engine().await {
                Ok(()) => installed = true,
                Err(e) if e.fatal => return Err(AgentEnd::Fatal(*e.said, e.kind)),
                Err(e) => return Err(AgentEnd::NotStarted(*e.said, e.kind)),
            }
        }
    }

    /// Whether the link still answers, within the probe timeout.
    async fn probe(&self, session: &dyn Session) -> bool {
        let probe = tokio::time::timeout(self.timings.probe_timeout, session.probe());
        probe.await.unwrap_or(false)
    }

    /// Subscribes to the change feed from the last change seen. Without the
    /// feed, the connection still serves; the app just hears of no changes.
    async fn subscribe(&mut self, agent: &Agent) -> Option<i64> {
        let params = SubscribeChangesParams {
            after: self.feed.clone(),
        };
        let timeout = self.timings.subscribe_timeout;
        let reply: Result<Subscription, _> = agent
            .call("subscribe_changes", Some(&params), timeout)
            .await;
        match reply {
            Ok(subscribed) => {
                // A feed that can't resume goes on from its latest; the app
                // reads everything again after any reconnect anyway.
                if subscribed.reset {
                    tracing::info!(
                        "{}: the change feed starts again: the Data folder's runs database is a \
                         new one",
                        self.publisher.platform
                    );
                }
                if subscribed.reset || self.feed.is_none() {
                    self.feed = Some(FeedPosition {
                        feed: subscribed.feed,
                        seq: subscribed.seq,
                    });
                }
                Some(subscribed.subscription)
            }
            Err(e) => {
                tracing::warn!(
                    "{}: no change feed this session: {e:?}",
                    self.publisher.platform
                );
                None
            }
        }
    }

    /// Hands on what a feed event says changed, and notes how far it got;
    /// another subscription's event goes on as it came.
    fn heard(&mut self, pushed: Pushed, subscription: Option<i64>) {
        if subscription != Some(pushed.subscription as i64) {
            return (self.on_event)(pushed);
        }
        match serde_json::from_value::<Changes>(pushed.event) {
            Ok(changes) => {
                if let (Some(feed), Some(last)) = (&mut self.feed, changes.changes.last()) {
                    feed.seq = last.seq;
                }
                (self.on_changes)(changes);
            }
            Err(e) => tracing::warn!("dropped a change event that doesn't fit: {e}"),
        }
    }

    async fn watch(
        &mut self,
        agent: &Agent,
        session: &dyn Session,
        mut events: Option<mpsc::UnboundedReceiver<Pushed>>,
        subscription: Option<i64>,
    ) -> AgentEnd {
        let every = self.timings.ping_every;
        let mut pings = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
        loop {
            tokio::select! {
                Some(pushed) = next_event(&mut events) => {
                    self.heard_at = Some((self.timings.now)());
                    self.heard(pushed, subscription);
                }
                _ = pings.tick() => match agent.ping(self.timings.ping_timeout).await {
                    Ok(()) => {
                        self.failures = 0;
                        self.heard_at = Some((self.timings.now)());
                    }
                    Err(CallError::Closed) => return exited(session).await,
                    // A ping lost with its link isn't the agent's fault.
                    Err(_) if !self.probe(session).await => return AgentEnd::LinkLost(LINK_LOST.into()),
                    Err(_) => return AgentEnd::Hung,
                },
                () = agent.closed() => return exited(session).await,
                () = session.closed() => return AgentEnd::LinkLost(LINK_LOST.into()),
                Some(()) = self.wakes.recv() => {
                    if !self.probe(session).await {
                        return AgentEnd::LinkLost("The connection didn’t survive sleep.".into());
                    }
                }
            }
        }
    }
}

/// The session's next feed event; never, without the events.
async fn next_event(events: &mut Option<mpsc::UnboundedReceiver<Pushed>>) -> Option<Pushed> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
    }
}

const LINK_LOST: &str = "Lost the connection.";
/// Opening a channel and starting the agent on it; `hello` has its own timeout.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// A dropped link closes the agent's channel before the session notices.
const LINK_GRACE: Duration = Duration::from_secs(1);

/// Why an agent's output ended: it exited, or its link went with it.
async fn exited(session: &dyn Session) -> AgentEnd {
    tokio::select! {
        () = session.closed() => AgentEnd::LinkLost(LINK_LOST.into()),
        () = tokio::time::sleep(LINK_GRACE) => AgentEnd::Exited,
    }
}

/// Hands each line of `stream` to `sink` until it ends, and returns the last.
async fn copy_lines(stream: impl AsyncRead + Unpin, sink: Arc<LineSink>) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut last = None;
    loop {
        match next_line(&mut reader, MAX_LINE_BYTES).await {
            Ok(Line::Complete(line)) => {
                sink(&line);
                let text = String::from_utf8_lossy(&line).trim().to_owned();
                if !text.is_empty() {
                    last = Some(text);
                }
            }
            Ok(Line::TooLong) => sink(b"(dropped a line longer than the line cap)"),
            Ok(Line::End) | Err(_) => return last,
        }
    }
}

/// Waits up to `grace` for the stderr copier to reach the end, and returns
/// the last line.
async fn finish(mut copier: JoinHandle<Option<String>>, grace: Duration) -> Option<String> {
    match tokio::time::timeout(grace, &mut copier).await {
        Ok(Ok(last)) => last,
        _ => {
            copier.abort();
            None
        }
    }
}

/// How often the wall-clock watch looks for a sleep.
const WAKE_TICK: Duration = Duration::from_secs(5);

/// Signals each time the wall clock shows the machine slept between ticks.
fn watch_the_wall_clock(tick: Duration) -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel(1);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last = SystemTime::now();
        loop {
            // The connection's end drops the receiver; the watch ends with it.
            tokio::select! {
                _ = ticker.tick() => {}
                () = tx.closed() => return,
            }
            let now = SystemTime::now();
            if policy::woke(now.duration_since(last).ok(), tick) {
                tracing::info!("the machine woke from sleep; checking the connection");
                if tx.send(()).await.is_err() {
                    return;
                }
            }
            last = now;
        }
    });
    rx
}
