//! The connection's timing rules, apart from any clock or transport.

use std::time::Duration;

use crate::agent::CallError;
use crate::wire::types::WireError;

/// The waits before reconnect attempts 1, 2, 3, …: the old app's schedule.
const BACKOFF_S: [u64; 5] = [5, 10, 20, 40, 60];
/// A write is re-sent for this long after it was first sent (ADR-0009).
const WRITE_RETRY_FOR: Duration = Duration::from_secs(180);
/// While a write waits for a reconnect, it checks again this often.
const WRITE_RETRY_EVERY: Duration = Duration::from_secs(1);

/// The wait before reconnect `attempt` (from 1): 5, 10, 20, 40, then 60 s,
/// moved by `jitter` × 20 % (`jitter` in −1…1), so desktops that lost the
/// same host don't all come back at once.
pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let index = (attempt.max(1) as usize - 1).min(BACKOFF_S.len() - 1);
    let base = Duration::from_secs(BACKOFF_S[index]);
    base.mul_f64(1.0 + 0.2 * jitter.clamp(-1.0, 1.0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Write,
}

/// How long to wait before sending a failed call again, or `None` to give
/// up. `retries` is how many times it was sent again already, and `elapsed`
/// the time since it was first sent.
///
/// A read goes again once, after a timeout or `unavailable`. A write carries
/// its `request_key`, so the agent answers a repeat with the first outcome:
/// it goes again after anything but an answer, for up to three minutes.
pub fn retry(kind: Kind, retries: u32, error: &CallError, elapsed: Duration) -> Option<Duration> {
    let asked_to_wait = match error {
        CallError::Agent(WireError::Unavailable { data, .. }) => {
            Some(Duration::from_millis(data.retry_after_ms.max(0) as u64))
        }
        _ => None,
    };
    match kind {
        Kind::Read if retries == 0 => match error {
            CallError::Timeout => Some(Duration::ZERO),
            _ => asked_to_wait,
        },
        Kind::Read => None,
        Kind::Write if elapsed >= WRITE_RETRY_FOR => None,
        Kind::Write => match error {
            CallError::Timeout => Some(Duration::ZERO),
            CallError::Closed | CallError::NotConnected => Some(WRITE_RETRY_EVERY),
            _ => asked_to_wait,
        }
        .map(|wait| wait.min(WRITE_RETRY_FOR - elapsed)),
    }
}

/// Whether the machine slept (or the app was frozen) between two ticks of a
/// ticker set to `tick`, given the wall-clock time between them: the monotonic
/// clock stops during sleep on macOS and Linux, so the tick itself comes late
/// only by the wall clock. `None` is a wall clock set back.
pub fn woke(wall_elapsed: Option<Duration>, tick: Duration) -> bool {
    wall_elapsed.is_some_and(|elapsed| elapsed > tick * 3)
}
