//! The client for one agent session: NDJSON requests out, replies matched
//! back to their calls by id, and the events a subscription pushes, over any
//! byte stream (a child's pipes or an SSH channel). No line the agent sends
//! ends the session; only its end does.

mod lines;

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::wire::commands::{MAX_LINE_BYTES, PROTOCOL_VERSION, timeout_ms};
use crate::wire::types::{DataFolderData, HelloParams, HelloResult, UnavailableSource, WireError};
pub(crate) use lines::{Line, next_line};

#[derive(Debug)]
pub enum CallError {
    /// The agent answered with an error.
    Agent(WireError),
    /// No reply in time; the session goes on.
    Timeout,
    /// The session ended before the reply came.
    Closed,
    /// No agent to ask: the platform isn't connected.
    NotConnected,
    /// A reply that doesn't fit the envelope or the method's type.
    BadReply(String),
}

/// The UI gets a failed call as a `WireError`, or as `{code, message}` with
/// the desktop's own codes: `timeout`, and `not_connected` when there's no
/// agent to ask.
impl Serialize for CallError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (code, message) = match self {
            CallError::Agent(error) => return error.serialize(serializer),
            CallError::Timeout => ("timeout", "The engine didn't answer in time.".to_owned()),
            CallError::Closed | CallError::NotConnected => {
                ("not_connected", "The platform isn't connected.".to_owned())
            }
            CallError::BadReply(detail) => (
                "internal",
                format!("The engine's reply didn't fit: {detail}"),
            ),
        };
        json!({"code": code, "message": message}).serialize(serializer)
    }
}

/// Why an agent couldn't start serving.
#[derive(Debug, Clone)]
pub enum StartError {
    /// It speaks another protocol (major.minor), named here.
    Version { agent: String },
    /// The Data folder can't hold the runs database.
    DataFolder(DataFolderData),
    /// The runs database is damaged, or isn't one: what SQLite said.
    Damaged(String),
    /// The Data folder is full, with what it has left when that's known.
    Full(Option<i64>),
    /// Another copy of ICMM was saving to the runs database.
    Busy,
    /// A newer engine is taking the runs in flight over from the older
    /// coordinators (the **Hand-over**, ADR-0020): ask again after `retry_after`.
    HandOver { retry_after: Duration },
    /// No answer in time.
    Timeout,
    /// It exited before it answered.
    Exited,
    /// It hit an error, which its log holds under `log_ref`.
    Internal { log_ref: String, message: String },
    /// It answered something this app can't read, or refused the request.
    Garbled(String),
}

type Reply = Result<Value, Value>;

/// An event a subscription pushed: `{subscription, event}`. It comes after
/// the reply that named its subscription.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Pushed {
    pub subscription: u64,
    pub event: Value,
}

pub struct Agent {
    shared: Arc<Shared>,
    tasks: [JoinHandle<()>; 2],
    /// Every subscription's events, in the order they came; taken once.
    events: Mutex<Option<mpsc::UnboundedReceiver<Pushed>>>,
}

struct Shared {
    /// Whole lines for the writer task: a caller that stops waiting never
    /// leaves half a line on the agent's stdin.
    outbox: mpsc::UnboundedSender<Outgoing>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    closed_notify: Notify,
    /// When the agent's output last moved, even mid-line.
    heard: Mutex<Instant>,
    events: mpsc::UnboundedSender<Pushed>,
}

struct Outgoing {
    line: Vec<u8>,
    written: oneshot::Sender<()>,
}

impl Agent {
    /// Starts a session on the agent's stdout (`reader`) and stdin (`writer`).
    pub fn new(
        reader: impl AsyncRead + Send + Unpin + 'static,
        writer: impl AsyncWrite + Send + Unpin + 'static,
    ) -> Agent {
        let (outbox, lines) = mpsc::unbounded_channel();
        let (events, pushed) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            outbox,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            closed_notify: Notify::new(),
            heard: Mutex::new(Instant::now()),
            events,
        });
        let reader = Heard {
            inner: reader,
            shared: shared.clone(),
        };
        let tasks = [
            tokio::spawn(read_replies(reader, shared.clone())),
            tokio::spawn(write_lines(writer, lines, shared.clone())),
        ];
        Agent {
            shared,
            tasks,
            events: Mutex::new(Some(pushed)),
        }
    }

    /// The events this session's subscriptions push, in order; `None` once
    /// taken. A reader that subscribes before it takes them loses none: they
    /// wait here.
    pub fn events(&self) -> Option<mpsc::UnboundedReceiver<Pushed>> {
        self.events.lock().unwrap().take()
    }

    /// Sends one request and waits up to `timeout` for its reply, counted
    /// from when the request has gone out whole.
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let mut request = json!({"method": method});
        if let Some(params) = params {
            request["params"] = params;
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        request["id"] = json!(id);
        let mut line = serde_json::to_vec(&request).expect("a JSON value encodes");
        line.push(b'\n');
        if line.len() > MAX_LINE_BYTES {
            return Err(CallError::BadReply(format!(
                "a {method} request would be longer than the line cap"
            )));
        }
        let (tx, rx) = oneshot::channel();
        let _waiting = Waiting::new(&self.shared, id, tx);
        // The reader may have closed the session before the call was listed:
        // then nothing will ever answer it.
        if self.is_closed() {
            return Err(CallError::Closed);
        }
        let (written, sent) = oneshot::channel();
        if self.shared.outbox.send(Outgoing { line, written }).is_err() || sent.await.is_err() {
            return Err(CallError::Closed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(error))) => Err(serde_json::from_value(error.clone())
                .map(CallError::Agent)
                .unwrap_or_else(|e| CallError::BadReply(format!("{e}: {error}")))),
            Ok(Err(_)) => Err(CallError::Closed),
            Err(_) => Err(CallError::Timeout),
        }
    }

    /// Sends a typed request and reads its typed reply.
    pub async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: Option<&P>,
        timeout: Duration,
    ) -> Result<R, CallError> {
        let params = params.map(|p| serde_json::to_value(p).expect("wire params encode"));
        let result = self.request(method, params, timeout).await?;
        serde_json::from_value(result).map_err(|e| CallError::BadReply(format!("{method}: {e}")))
    }

    /// The handshake: sends this app's protocol and checks the agent's,
    /// waiting up to `timeout` for the answer (the app's connections wait
    /// `method_timeout("hello")`).
    pub async fn hello(
        &self,
        app_version: &str,
        timeout: Duration,
    ) -> Result<HelloResult, StartError> {
        let params = HelloParams {
            protocol: PROTOCOL_VERSION.to_owned(),
            app_version: app_version.to_owned(),
        };
        let result: Result<HelloResult, _> = self.call("hello", Some(&params), timeout).await;
        match result {
            Ok(hello) if major_minor(&hello.protocol) == major_minor(PROTOCOL_VERSION) => Ok(hello),
            Ok(hello) => Err(StartError::Version {
                agent: hello.protocol,
            }),
            Err(CallError::Agent(WireError::VersionMismatch { data, .. })) => {
                Err(StartError::Version {
                    agent: data.protocol,
                })
            }
            Err(CallError::Agent(WireError::DataFolder { data, .. })) => {
                Err(StartError::DataFolder(data))
            }
            Err(CallError::Agent(WireError::DbCorrupt { data, .. })) => {
                Err(StartError::Damaged(data.detail))
            }
            Err(CallError::Agent(WireError::NoSpace { data, .. })) => {
                Err(StartError::Full(data.free_bytes))
            }
            Err(CallError::Agent(WireError::Unavailable { data, .. }))
                if data.source == UnavailableSource::HandOver =>
            {
                Err(StartError::HandOver {
                    retry_after: Duration::from_millis(data.retry_after_ms.max(0) as u64),
                })
            }
            Err(CallError::Agent(WireError::Unavailable { .. })) => Err(StartError::Busy),
            Err(CallError::Agent(WireError::Internal { message, data })) => {
                Err(StartError::Internal {
                    log_ref: data.log_ref,
                    message,
                })
            }
            Err(CallError::Timeout) => Err(StartError::Timeout),
            Err(CallError::Closed | CallError::NotConnected) => Err(StartError::Exited),
            Err(CallError::Agent(e)) => Err(StartError::Garbled(said(&e))),
            Err(CallError::BadReply(detail)) => Err(StartError::Garbled(detail)),
        }
    }

    /// Checks the agent still answers. An agent still sending something long
    /// counts as answering: its ping reply waits behind that line.
    pub async fn ping(&self, timeout: Duration) -> Result<(), CallError> {
        let asked = Instant::now();
        match self.request("ping", None, timeout).await {
            Err(CallError::Timeout) if *self.shared.heard.lock().unwrap() > asked => Ok(()),
            outcome => outcome.map(drop),
        }
    }

    /// Resolves once the agent's output has ended.
    pub async fn closed(&self) {
        let notified = self.shared.closed_notify.notified();
        if !self.is_closed() {
            notified.await;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A call's place in `pending`, given up when the call is.
struct Waiting<'a> {
    shared: &'a Shared,
    id: u64,
}

impl<'a> Waiting<'a> {
    fn new(shared: &'a Shared, id: u64, reply: oneshot::Sender<Reply>) -> Waiting<'a> {
        shared.pending.lock().unwrap().insert(id, reply);
        Waiting { shared, id }
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.shared.pending.lock().unwrap().remove(&self.id);
    }
}

async fn write_lines(
    mut writer: impl AsyncWrite + Unpin,
    mut lines: mpsc::UnboundedReceiver<Outgoing>,
    shared: Arc<Shared>,
) {
    while let Some(Outgoing { line, written }) = lines.recv().await {
        if writer.write_all(&line).await.is_err() || writer.flush().await.is_err() {
            close(&shared);
            return;
        }
        let _ = written.send(());
    }
}

/// The agent's stdout, noting when anything arrives.
struct Heard<R> {
    inner: R,
    shared: Arc<Shared>,
}

impl<R: AsyncRead + Unpin> AsyncRead for Heard<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if buf.filled().len() > before {
            *self.shared.heard.lock().unwrap() = Instant::now();
        }
        polled
    }
}

/// A method's reply timeout, from the registry.
pub fn method_timeout(method: &str) -> Duration {
    Duration::from_millis(timeout_ms(method).expect("an agent method in the registry"))
}

fn major_minor(protocol: &str) -> Vec<&str> {
    protocol.split('.').take(2).collect()
}

async fn read_replies(reader: impl AsyncRead + Unpin, shared: Arc<Shared>) {
    let mut reader = BufReader::new(reader);
    loop {
        match next_line(&mut reader, MAX_LINE_BYTES).await {
            Ok(Line::Complete(line)) => route(&line, &shared),
            Ok(Line::TooLong) => {
                tracing::warn!("dropped a line from the engine longer than the line cap")
            }
            Ok(Line::End) => break,
            Err(e) => {
                tracing::warn!("reading the engine's output failed: {e}");
                break;
            }
        }
    }
    close(&shared);
}

fn close(shared: &Shared) {
    shared.closed.store(true, Ordering::Release);
    // Dropping the senders wakes every waiting call with `Closed`.
    shared.pending.lock().unwrap().clear();
    shared.closed_notify.notify_waiters();
}

fn route(line: &[u8], shared: &Shared) {
    let Ok(Value::Object(mut message)) = serde_json::from_slice::<Value>(line) else {
        tracing::warn!(
            "dropped a line from the engine that isn't a JSON object: {:.200}",
            String::from_utf8_lossy(line)
        );
        return;
    };
    if let Some(event) = message.remove("event") {
        match message.get("subscription").and_then(Value::as_u64) {
            Some(subscription) => {
                // Nobody listening is no reason to end the session.
                let _ = shared.events.send(Pushed {
                    subscription,
                    event,
                });
            }
            None => tracing::warn!("dropped an event from the engine without a subscription"),
        }
        return;
    }
    let reply = match (message.remove("result"), message.remove("error")) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => {
            tracing::warn!("dropped a line from the engine that isn't a reply: {message:?}");
            return;
        }
    };
    match message.get("id").and_then(Value::as_u64) {
        Some(id) => match shared.pending.lock().unwrap().remove(&id) {
            Some(waiting) => {
                let _ = waiting.send(reply);
            }
            None => tracing::warn!("dropped a reply to id {id}, which nothing is waiting for"),
        },
        None => tracing::warn!("the engine refused a line: {reply:?}"),
    }
}

/// What an error says, in its own sentence.
fn said(error: &WireError) -> String {
    serde_json::to_value(error)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_default()
}
