//! The app's diagnostic log (old ADR-0021).
//!
//! A packaged Windows build detaches its console, so stdout alone leaves
//! nothing on disk to send back. Everything the app logs, the webview's
//! reports included, goes to stdout and to a daily `app.<date>.log` in the
//! app's log folder, beside the agents' `agent.<date>.log`. The folder keeps
//! the last seven days by date, however many days ICMM was opened on.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::wire::types::{LogFrontendEventParams, LogLevel};

/// Starts the log: stdout, plus `dir/app.<date>.log` when `dir` is given and
/// writable. Only the first call takes effect.
pub fn init(dir: Option<&Path>) {
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("icmm_desktop=debug"));
    // `Option<Layer>` is a no-op layer when `None`, so an unwritable folder
    // leaves stdout working rather than failing the launch.
    let file = dir.and_then(|dir| {
        // Pruning old logs reads the folder, and fails on a first launch
        // before the appender has made it.
        std::fs::create_dir_all(dir).ok()?;
        tracing_appender::rolling::RollingFileAppender::builder()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("app")
            .filename_suffix("log")
            .build(dir)
            .ok()
            .map(|appender| {
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(appender)
            })
    });
    let owned = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(file)
        .try_init()
        .is_ok();
    if owned {
        log_panics();
    }
    if let Some(dir) = dir {
        keep_a_week(dir.to_owned());
    }
}

/// How many days of logs the folder keeps: today's and the six before.
const DAYS_KEPT: i64 = 7;

/// Prunes the logs folder now, then every hour while ICMM stays open.
fn keep_a_week(dir: std::path::PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("prune-logs".into())
        .spawn(move || {
            loop {
                prune(&dir, today());
                std::thread::sleep(Duration::from_secs(60 * 60));
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("couldn't start pruning the logs: {e}");
    }
}

/// Days since 1970 today, in UTC, as the logs' file names count them.
fn today() -> i64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    (since.as_secs() / 86_400) as i64
}

/// Deletes the app's and agents' logs in `dir` from before the last seven
/// days, `today` counted in days since 1970. Other files stay.
pub fn prune(dir: &Path, today: i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let oldest = date(today - (DAYS_KEPT - 1));
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(day) = name.to_str().and_then(log_date) else {
            continue;
        };
        if day < oldest.as_str() {
            let path = entry.path();
            match std::fs::remove_file(&path) {
                Ok(()) => tracing::debug!("pruned {}", path.display()),
                // Reset deleted it meanwhile.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => tracing::warn!("couldn't prune {}: {e}", path.display()),
            }
        }
    }
}

/// The date of an `app.<date>.log` or `agent.<date>.log`.
pub fn log_date(name: &str) -> Option<&str> {
    let rest = name
        .strip_prefix("app.")
        .or_else(|| name.strip_prefix("agent."))?;
    let day = rest.strip_suffix(".log")?;
    let shaped = day.len() == 10
        && day.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    shaped.then_some(day)
}

/// The date `days` after 1970-01-01, written `YYYY-MM-DD` (Hinnant's
/// civil-from-days).
fn date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The logs folder as Settings shows it: from `~/` on macOS and Linux, and
/// written out in full on Windows, where people don't write `~`.
pub fn shown(path: &Path, home: Option<&Path>, windows: bool) -> String {
    let rest = home
        .filter(|_| !windows)
        .and_then(|h| path.strip_prefix(h).ok());
    match rest {
        Some(rest) => {
            let parts: Vec<String> = rest
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            format!("~/{}", parts.join("/"))
        }
        None => path.display().to_string(),
    }
}

/// Sends panics to the log before the default hook prints them to a stderr
/// that a packaged Windows build throws away.
fn log_panics() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        tracing::error!(target: "icmm_desktop::panic", "panic: {info}\n{backtrace}");
        default_hook(info);
    }));
}

/// Writes a report from the webview into the app log.
pub fn log_frontend_event(LogFrontendEventParams { level, message }: LogFrontendEventParams) {
    match level {
        LogLevel::Error => tracing::error!(target: "icmm_desktop::frontend", "{message}"),
        LogLevel::Warn => tracing::warn!(target: "icmm_desktop::frontend", "{message}"),
        LogLevel::Info => tracing::info!(target: "icmm_desktop::frontend", "{message}"),
        LogLevel::Debug => tracing::debug!(target: "icmm_desktop::frontend", "{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Subscriber};
    use tracing_subscriber::Layer;
    use tracing_subscriber::layer::{Context, SubscriberExt};

    type Captured = Arc<Mutex<Vec<(Level, String, String)>>>;

    struct Message(Option<String>);

    impl Visit for Message {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.0 = Some(format!("{value:?}"));
            }
        }
    }

    /// Records each event's level, target and message.
    struct Capture(Captured);

    impl<S: Subscriber> Layer<S> for Capture {
        fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
            let mut message = Message(None);
            event.record(&mut message);
            let meta = event.metadata();
            self.0.lock().unwrap().push((
                *meta.level(),
                meta.target().to_owned(),
                message.0.unwrap_or_default(),
            ));
        }
    }

    fn captured(f: impl FnOnce()) -> Vec<(Level, String, String)> {
        let events = Captured::default();
        let subscriber = tracing_subscriber::registry().with(Capture(events.clone()));
        tracing::subscriber::with_default(subscriber, f);
        events.lock().unwrap().clone()
    }

    #[test]
    fn each_level_lands_at_its_own_level_with_the_message_verbatim() {
        let log = |level, message: &str| {
            log_frontend_event(LogFrontendEventParams {
                level,
                message: message.into(),
            })
        };
        let events = captured(|| {
            log(LogLevel::Error, "boom: {not a format}");
            log(LogLevel::Warn, "careful");
            log(LogLevel::Info, "hello");
            log(LogLevel::Debug, "detail");
        });
        let frontend = "icmm_desktop::frontend".to_owned();
        assert_eq!(
            events,
            vec![
                (
                    Level::ERROR,
                    frontend.clone(),
                    "boom: {not a format}".into()
                ),
                (Level::WARN, frontend.clone(), "careful".into()),
                (Level::INFO, frontend.clone(), "hello".into()),
                (Level::DEBUG, frontend, "detail".into()),
            ]
        );
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn logs_from_before_the_last_seven_days_go_however_few_there_are() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path();
        for name in [
            "app.2026-09-20.log",
            "app.2026-09-29.log",
            "app.2026-09-30.log",
            "app.2026-10-06.log",
            "agent.2026-09-01.log",
            "agent.2026-10-05.log",
            "notes.txt",
        ] {
            std::fs::write(logs.join(name), "a line\n").unwrap();
        }

        // 2026-10-06: it and the six days before it are kept.
        prune(logs, 20_732);

        assert_eq!(
            names(logs),
            [
                "agent.2026-10-05.log",
                "app.2026-09-30.log",
                "app.2026-10-06.log",
                "notes.txt"
            ]
        );
    }

    #[test]
    fn a_missing_logs_folder_has_nothing_to_prune() {
        let dir = tempfile::tempdir().unwrap();
        prune(&dir.path().join("logs"), 20_732);
    }

    #[test]
    fn days_since_1970_are_the_dates_the_logs_are_named_for() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(11_016), "2000-02-29");
        assert_eq!(date(20_732), "2026-10-06");
    }

    #[test]
    fn the_logs_folder_shows_from_home_except_on_windows() {
        assert_eq!(
            shown(
                Path::new("/Users/ada/Library/Logs/org.meschoening.icmm"),
                Some(Path::new("/Users/ada")),
                false
            ),
            "~/Library/Logs/org.meschoening.icmm"
        );
        assert_eq!(
            shown(
                Path::new("/var/log/org.meschoening.icmm"),
                Some(Path::new("/Users/ada")),
                false
            ),
            "/var/log/org.meschoening.icmm"
        );
        let windows = r"C:\Users\Ada\AppData\Local\org.meschoening.icmm\logs";
        assert_eq!(
            shown(Path::new(windows), Some(Path::new(r"C:\Users\Ada")), true),
            windows
        );
    }

    #[test]
    fn a_level_outside_the_four_is_refused() {
        assert_eq!(
            serde_json::from_str::<LogLevel>(r#""warn""#).unwrap(),
            LogLevel::Warn
        );
        assert!(serde_json::from_str::<LogLevel>(r#""nonsense""#).is_err());
        assert!(serde_json::from_str::<LogLevel>(r#""WARN""#).is_err());
    }
}
