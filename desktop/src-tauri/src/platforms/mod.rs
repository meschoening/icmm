//! The compute platforms this computer knows (ADR-0001): their Connection
//! details, saved in the app's config folder, and the one connection to the
//! Active platform.
//!
//! Launch connects to the launch choice, which the first connect sets and
//! the user changes, or shows the Active platform not connected when it's
//! Don't connect. Connecting to another platform ends the first connection
//! and leaves the choice; Disconnect ends it however far it got, so it also
//! cancels a connect and stops reconnecting, for now: the choice still
//! connects at the next launch. Saving how the Active platform is reached
//! reconnects, and removing it disconnects first. Retry now starts a failed connect over, or ends a
//! reconnect's wait. Trusting a host key lets a waiting connect go on;
//! forgetting a changed one's old key connects again, to ask about the new.
//!
//! A platform is remembered as connected the first time it connects, so a
//! key it refuses later is a failure rather than a first connect's question
//! (ADR-0012). When the connect asks for a key, the password adds ICMM's key
//! and saves it as the key for the host that asked; a key the user chooses
//! instead is saved, then connected with.

pub mod keys;
pub mod ssh_config;
pub mod store;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use zeroize::Zeroizing;

use crate::agent::{CallError, Pushed};
use crate::connection::known_hosts;
use crate::connection::platform::Platform;
use crate::connection::policy::Kind;
use crate::connection::{AddKeyFailure, Connection, LineSink, Options, Timings, unix_ms};
use crate::engine::Engines;
use crate::platforms::store::tilde;
use crate::wire::types::{
    Changes, ConflictData, ConnectionState, ConnectionStatus, InternalData, InvalidData, Issue,
    PlatformForm, SavedPlatforms, Severity, WireError,
};
use store::{Launch, Saved};

/// Takes each new connection state.
pub type OnState = Box<dyn Fn(ConnectionState) + Send + Sync>;
/// Takes what each change-feed event says changed.
pub type OnChanges = Box<dyn Fn(Changes) + Send + Sync>;
/// Takes each event of the other subscriptions a page holds, such as
/// `watch_start`'s.
pub type OnEvent = Box<dyn Fn(Pushed) + Send + Sync>;

/// Starts connections: the app's reaches real platforms, tests' fake ones.
pub trait Connector: Send + Sync {
    /// Starts connecting to `platform`, which connected from this computer
    /// before or not, handing each state to `on_state` and each change in its
    /// runs database to `on_changes`, and each event of a page's own
    /// subscription to `on_event`. `forgot` is whether the user just forgot
    /// its host's old key.
    fn connect(
        &self,
        platform: &Platform,
        connected_before: bool,
        forgot: bool,
        on_state: OnState,
        on_changes: OnChanges,
        on_event: OnEvent,
    ) -> Connection;
}

/// Reaches real platforms: over SSH, or a child process here.
pub struct RealConnector {
    pub app_version: String,
    /// The engine bundles this app carries.
    pub engines: Engines,
    /// Takes each line the agent writes to stderr.
    pub agent_log: Arc<LineSink>,
}

impl Connector for RealConnector {
    fn connect(
        &self,
        platform: &Platform,
        connected_before: bool,
        forgot: bool,
        on_state: OnState,
        on_changes: OnChanges,
        on_event: OnEvent,
    ) -> Connection {
        let agent_log = self.agent_log.clone();
        let options = Options {
            app_version: self.app_version.clone(),
            timings: Timings::default(),
            on_state,
            on_changes,
            on_event,
            wakes: None,
            agent_log: Box::new(move |line| agent_log(line)),
            connected_before,
            forgot,
        };
        Connection::start(platform.name(), platform.transport(&self.engines), options)
    }
}

pub struct Platforms {
    saved: Arc<Mutex<Saved>>,
    connector: Box<dyn Connector>,
    published: Arc<Published>,
    /// The connection, held across a switch so two can't overlap.
    active: tokio::sync::Mutex<Option<Active>>,
}

struct Active {
    id: String,
    connection: Arc<Connection>,
}

/// What the app was last told, and which connection may tell it more.
struct Published {
    on_state: OnState,
    on_changes: OnChanges,
    on_event: OnEvent,
    now: Mutex<Now>,
}

struct Now {
    /// Only the connection started under this generation is heard.
    generation: u64,
    id: Option<String>,
    name: Option<String>,
    state: ConnectionState,
}

/// `status`, with no connect under way.
fn bare(status: ConnectionStatus) -> ConnectionState {
    ConnectionState {
        status,
        platform_id: None,
        platform: None,
        reason: None,
        next_step: None,
        details: None,
        fixes: Vec::new(),
        can_retry: false,
        since: (status != ConnectionStatus::None).then(unix_ms),
        steps: Vec::new(),
        upload: None,
        failure: None,
        retry: None,
        host_key: None,
        key_question: None,
        engine_version: None,
        heard_at: None,
    }
}

impl Published {
    /// Tells the app `status`, with no connect under way.
    fn send(&self, now: &mut Now, status: ConnectionStatus) {
        self.send_state(now, bare(status));
    }

    /// Tells the app `state` as the platform `now` names.
    fn send_state(&self, now: &mut Now, state: ConnectionState) {
        now.state = ConnectionState {
            platform_id: now.id.clone(),
            platform: now.name.clone(),
            ..state
        };
        (self.on_state)(now.state.clone());
    }

    /// A state from the connection started under `generation`, unless a newer
    /// one has started since.
    fn heard(&self, generation: u64, state: ConnectionState) {
        let mut now = self.now.lock().unwrap();
        if now.generation == generation {
            self.send_state(&mut now, state);
        }
    }

    /// Changes from the connection started under `generation`, unless a newer
    /// one has started since.
    fn changed(&self, generation: u64, changes: Changes) {
        let now = self.now.lock().unwrap();
        if now.generation == generation {
            (self.on_changes)(changes);
        }
    }

    /// A subscription's event from the connection started under
    /// `generation`, unless a newer one has started since.
    fn pushed(&self, generation: u64, event: Pushed) {
        let now = self.now.lock().unwrap();
        if now.generation == generation {
            (self.on_event)(event);
        }
    }
}

impl Platforms {
    /// Serves the saved platforms; nothing connects until `launch`. The
    /// Active platform's connection states go to `on_state`, the changes in
    /// its runs database to `on_changes`, and its page's own subscriptions'
    /// events to `on_event`.
    pub fn new(
        saved: Saved,
        connector: Box<dyn Connector>,
        on_state: OnState,
        on_changes: OnChanges,
        on_event: OnEvent,
    ) -> Arc<Platforms> {
        let none = bare(ConnectionStatus::None);
        Arc::new(Platforms {
            saved: Arc::new(Mutex::new(saved)),
            connector,
            published: Arc::new(Published {
                on_state,
                on_changes,
                on_event,
                now: Mutex::new(Now {
                    generation: 0,
                    id: None,
                    name: None,
                    state: none,
                }),
            }),
            active: tokio::sync::Mutex::new(None),
        })
    }

    /// Connects to the launch choice, making it the Active platform; with
    /// Don't connect, the Active platform shows not connected.
    pub async fn launch(&self) {
        let (launch, target) = {
            let saved = self.saved.lock().unwrap();
            let launch = saved.launch();
            let target = match &launch {
                Launch::Connect(id) | Launch::NotConnected(id) => saved.target(id),
                Launch::Nothing => None,
            };
            (launch, target)
        };
        match (launch, target) {
            (Launch::Connect(id), Some(_)) => {
                let mut active = self.active.lock().await;
                // It connects all the same when the choice can't be saved as
                // the Active platform: the next connect saves it.
                if let Err(e) = self.saved.lock().unwrap().activate(&id) {
                    tracing::error!("couldn't make {id} the Active platform: {e:?}");
                }
                self.start(&mut active, &id, false);
            }
            (Launch::NotConnected(id), Some(target)) => {
                let mut now = self.published.now.lock().unwrap();
                now.id = Some(id);
                now.name = Some(target.name());
                self.published
                    .send(&mut now, ConnectionStatus::NotConnected);
            }
            _ => self.forget_active(),
        }
    }

    /// The connection now.
    pub fn state(&self) -> ConnectionState {
        self.published.now.lock().unwrap().state.clone()
    }

    pub fn view(&self) -> SavedPlatforms {
        self.saved.lock().unwrap().view()
    }

    /// Saves a new SSH platform and connects to it; answers its id.
    pub async fn add(&self, form: PlatformForm) -> Result<String, WireError> {
        let id = self.saved.lock().unwrap().add(form)?;
        self.connect(&id).await?;
        Ok(id)
    }

    /// Makes `id` the Active platform and connects, ending any other connection.
    pub async fn connect(&self, id: &str) -> Result<(), WireError> {
        // Under the connection's lock, so a Reset under way finishes first.
        let mut active = self.active.lock().await;
        self.saved.lock().unwrap().activate(id)?;
        self.stop(&mut active).await;
        self.start(&mut active, id, false);
        Ok(())
    }

    /// Ends the connection however far it got, for now: the launch choice
    /// still connects when ICMM next opens.
    pub async fn disconnect(&self) -> Result<(), WireError> {
        let mut active = self.active.lock().await;
        self.stop(&mut active).await;
        let mut now = self.published.now.lock().unwrap();
        if now.id.is_some() {
            self.published
                .send(&mut now, ConnectionStatus::NotConnected);
        }
        Ok(())
    }

    /// Sets the platform to connect to when ICMM opens, or Don't connect
    /// (`None`); nothing connects now.
    pub fn set_launch(&self, id: Option<&str>) -> Result<(), WireError> {
        self.saved.lock().unwrap().set_launch(id)
    }

    /// Tries again at once: a failed connect starts over, and a reconnect
    /// stops waiting. Anything else is left as it is.
    pub async fn retry_now(&self) -> Result<(), WireError> {
        let (status, id) = {
            let now = self.published.now.lock().unwrap();
            (now.state.status, now.id.clone())
        };
        match (status, id) {
            (ConnectionStatus::Failed, Some(id)) => self.connect(&id).await,
            (ConnectionStatus::Reconnecting, _) => {
                if let Some(active) = self.active.lock().await.as_ref() {
                    active.connection.retry_now();
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Trusts the host key the Active platform's connect waits on, if it's
    /// the one with `fingerprint`.
    pub async fn trust_host_key(&self, fingerprint: &str) -> Result<(), WireError> {
        let trusted = self
            .active
            .lock()
            .await
            .as_ref()
            .is_some_and(|a| a.connection.trust_host_key(fingerprint));
        if trusted {
            Ok(())
        } else {
            Err(stale("The connect isn’t waiting on that key any more."))
        }
    }

    /// Forgets the old key of the Active platform's changed host key, if
    /// it's the one with `fingerprint`, then connects again: the next
    /// connect asks about the key the host has now.
    pub async fn forget_host_key(&self, fingerprint: &str) -> Result<(), WireError> {
        // Held to the end, so a Disconnect or a switch the user makes
        // meanwhile comes after the reconnect, and a second Forget finds no
        // question left.
        let mut active = self.active.lock().await;
        let found = active.as_ref().and_then(|a| {
            let question = a.connection.host_key()?;
            let recorded = question.recorded.as_ref()?;
            (known_hosts::fingerprint(&recorded.key) == fingerprint)
                .then(|| (a.id.clone(), question.clone()))
        });
        let (id, question) =
            found.ok_or_else(|| stale("There’s no changed host key to forget."))?;
        if let Err(e) = question.forget().await {
            let recorded = question.recorded.as_ref().expect("checked above");
            let message = format!(
                "Couldn’t remove line {} from {}: {e}.",
                recorded.line,
                tilde(&recorded.file)
            );
            tracing::error!("{message}");
            return Err(WireError::Internal {
                message,
                data: InternalData {
                    log_ref: "app.log".into(),
                },
            });
        }
        self.stop(&mut active).await;
        self.start(&mut active, &id, true);
        Ok(())
    }

    /// Turns the Active platform's refused sign-in into the key question.
    pub async fn set_up_ssh_key(&self) -> Result<(), WireError> {
        match self.connection().await {
            Some((_, connection)) if connection.set_up_key().await => Ok(()),
            _ => Err(no_key_question()),
        }
    }

    /// Adds ICMM's key to the host the Active platform's connect asks about,
    /// with `password`, and saves it as that host's key; the connect goes on
    /// with it. A wrong password leaves the question; any other failure shows
    /// in the connection.
    pub async fn add_ssh_key(&self, password: String) -> Result<(), WireError> {
        let password = Zeroizing::new(password);
        // An empty one would only count against the host's wrong tries.
        if password.is_empty() {
            return Err(WireError::Invalid {
                message: "Enter your password.".into(),
                data: InvalidData {
                    issues: vec![Issue {
                        path: vec!["password".into()],
                        message: "Enter your password.".into(),
                        severity: Severity::Error,
                    }],
                },
            });
        }
        let Some((id, connection)) = self.connection().await else {
            return Err(no_key_question());
        };
        let Some(ask) = connection.key_question() else {
            return Err(no_key_question());
        };
        match connection.add_key(password).await {
            Ok(added) => {
                let key = tilde(&added.file);
                let saved = self.saved.lock().unwrap().use_key(&id, added.hop, &key);
                // The connect goes on with the key either way; only the next
                // one would miss it.
                if let Err(e) = saved {
                    tracing::error!("couldn't save {key} as the platform's key: {e:?}");
                }
                Ok(())
            }
            Err(AddKeyFailure::WrongPassword) => Err(wrong_password(&ask.question.host)),
            Err(AddKeyFailure::Stale) => Err(no_key_question()),
            Err(AddKeyFailure::NoPassword | AddKeyFailure::Failed) => Ok(()),
        }
    }

    /// Saves `identity_file` as the key for the host the Active platform's
    /// connect asks about, and connects again with it.
    pub async fn use_ssh_key(&self, identity_file: &str) -> Result<(), WireError> {
        let mut active = self.active.lock().await;
        let asked = active.as_ref().and_then(|a| {
            let ask = a.connection.key_question()?;
            Some((a.id.clone(), ask.hop))
        });
        let (id, hop) = asked.ok_or_else(no_key_question)?;
        self.saved
            .lock()
            .unwrap()
            .use_key(&id, hop, identity_file)?;
        self.stop(&mut active).await;
        self.start(&mut active, &id, false);
        Ok(())
    }

    /// The Active platform's id and connection, if it's connecting or more.
    async fn connection(&self) -> Option<(String, Arc<Connection>)> {
        let active = self.active.lock().await;
        active
            .as_ref()
            .map(|a| (a.id.clone(), a.connection.clone()))
    }

    /// Saves a platform's form. The Active platform reconnects when how it's
    /// reached changed, unless the user disconnected it; a new name shows at once.
    pub async fn edit(&self, id: &str, form: PlatformForm) -> Result<(), WireError> {
        let (changed, name) = {
            let mut saved = self.saved.lock().unwrap();
            let changed = saved.edit(id, form)?;
            (changed, saved.name(id))
        };
        let mut active = self.active.lock().await;
        let live = active.as_ref().is_some_and(|a| a.id == id);
        if changed && live {
            self.stop(&mut active).await;
            self.start(&mut active, id, false);
            return Ok(());
        }
        let mut now = self.published.now.lock().unwrap();
        if now.id.as_deref() == Some(id) && now.name != name {
            now.name = name;
            let state = now.state.clone();
            self.published.send_state(&mut now, state);
        }
        Ok(())
    }

    /// Forgets a platform, and disconnects when it's the Active one. It's
    /// forgotten first, so a save that fails leaves the connection as it was.
    pub async fn remove(&self, id: &str) -> Result<(), WireError> {
        let mut active = self.active.lock().await;
        self.saved.lock().unwrap().remove(id)?;
        if active.as_ref().is_some_and(|a| a.id == id) {
            self.stop(&mut active).await;
        }
        if self.published.now.lock().unwrap().id.as_deref() == Some(id) {
            self.forget_active();
        }
        Ok(())
    }

    /// Disconnects and forgets every saved platform: First launch. When the
    /// files can't all go, what's left still loads, not connected.
    pub async fn forget_all(&self) -> std::io::Result<()> {
        let mut active = self.active.lock().await;
        self.stop(&mut active).await;
        let (forgotten, left) = {
            let mut saved = self.saved.lock().unwrap();
            let forgotten = saved.forget_all();
            let left = saved.view().active;
            (forgotten, left.and_then(|id| Some((saved.name(&id)?, id))))
        };
        match left {
            Some((name, id)) => {
                let mut now = self.published.now.lock().unwrap();
                now.id = Some(id);
                now.name = Some(name);
                self.published
                    .send(&mut now, ConnectionStatus::NotConnected);
            }
            None => self.forget_active(),
        }
        forgotten
    }

    /// Calls an agent method on the Active platform: what every generated
    /// agent command does.
    pub async fn call<P: Serialize + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        kind: Kind,
        params: Option<&P>,
        timeout: Duration,
    ) -> Result<R, CallError> {
        let connection = self
            .active
            .lock()
            .await
            .as_ref()
            .map(|a| a.connection.clone());
        match connection {
            Some(connection) => connection.call(method, kind, params, timeout).await,
            None => Err(CallError::NotConnected),
        }
    }

    /// Starts connecting to `id`, heard under a new generation. Its first
    /// connect is remembered.
    /// Starts connecting to platform `id`; `forgot` is whether the user just
    /// forgot its host's old key.
    fn start(&self, active: &mut Option<Active>, id: &str, forgot: bool) {
        let (target, connected_before) = {
            let saved = self.saved.lock().unwrap();
            let Some(target) = saved.target(id) else {
                return;
            };
            (target, saved.connected_before(id))
        };
        let generation = {
            let mut now = self.published.now.lock().unwrap();
            now.generation += 1;
            now.id = Some(id.to_owned());
            now.name = Some(target.name());
            now.generation
        };
        let published = self.published.clone();
        let remembered = AtomicBool::new(connected_before);
        let saved = self.saved.clone();
        let platform = id.to_owned();
        let endpoint = target.clone();
        let on_state: OnState = Box::new(move |state| {
            if state.status == ConnectionStatus::Connected
                && !remembered.swap(true, Ordering::SeqCst)
            {
                let (saved, platform, endpoint) =
                    (saved.clone(), platform.clone(), endpoint.clone());
                tokio::task::spawn_blocking(move || {
                    if let Err(e) = saved.lock().unwrap().connected(&platform, &endpoint) {
                        tracing::error!("couldn't remember that {platform} connected: {e:?}");
                    }
                });
            }
            published.heard(generation, state);
        });
        let published = self.published.clone();
        let on_changes: OnChanges = Box::new(move |changes| published.changed(generation, changes));
        let published = self.published.clone();
        let on_event: OnEvent = Box::new(move |event| published.pushed(generation, event));
        let connection = self.connector.connect(
            &target,
            connected_before,
            forgot,
            on_state,
            on_changes,
            on_event,
        );
        *active = Some(Active {
            id: id.to_owned(),
            connection: Arc::new(connection),
        });
    }

    /// Ends the connection, if any; nothing more is heard from it.
    async fn stop(&self, active: &mut Option<Active>) {
        if let Some(old) = active.take() {
            self.published.now.lock().unwrap().generation += 1;
            old.connection.disconnect().await;
        }
    }

    /// No Active platform: First launch.
    fn forget_active(&self) {
        let mut now = self.published.now.lock().unwrap();
        now.id = None;
        now.name = None;
        self.published.send(&mut now, ConnectionStatus::None);
    }
}

/// The user acted on a host key the connect no longer stops at.
fn stale(message: &str) -> WireError {
    WireError::Conflict {
        message: message.to_owned(),
        data: ConflictData {
            reason: "stale_host_key".into(),
        },
    }
}

/// The password the host refused, said where the field shows it.
fn wrong_password(host: &str) -> WireError {
    WireError::Invalid {
        message: format!("{host} didn’t accept that password."),
        data: InvalidData {
            issues: vec![Issue {
                path: vec!["password".into()],
                message: format!(
                    "{host} didn’t accept that password. Check it and try again: after several \
                     wrong tries, the cluster blocks this computer for a while."
                ),
                severity: Severity::Error,
            }],
        },
    }
}

/// The user answered a key question the connect no longer asks.
fn no_key_question() -> WireError {
    WireError::Conflict {
        message: "The connect isn’t waiting for a key any more.".to_owned(),
        data: ConflictData {
            reason: "stale_key_question".into(),
        },
    }
}
