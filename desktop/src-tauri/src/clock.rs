//! Whether this computer's settings set a 12- or 24-hour clock, which the
//! app shows times by ("Clock times", #116). A WebView's `Intl` goes by its
//! language, not the computer's region or its 24-hour switch: WebView2
//! ignores Windows' time format, and WKWebView the region's clock.
//!
//! - macOS: the system's own formatter, asked through AppleScript for the
//!   time at 13:00, which follows both the region and General › Date & Time
//!   › 24-hour time.
//! - Windows: Region's short time format (`sShortTime`), which always has one.
//! - Linux: GNOME's `clock-format`, where there's GNOME.
//!
//! Without one, the language decides (`null`).

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::wire::types::TimeFormat;

const CLOCK_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn time_format() -> TimeFormat {
    TimeFormat {
        twelve_hour: twelve_hour().await,
    }
}

#[cfg(target_os = "macos")]
async fn twelve_hour() -> Option<bool> {
    let one_pm = output(
        "osascript",
        &[
            "-e",
            "set d to current date",
            "-e",
            "set hours of d to 13",
            "-e",
            "time string of d",
        ],
    )
    .await?;
    one_pm_is_12_hour(&one_pm)
}

/// Whether the time 13:00, as the system writes it ("1:13:54 PM",
/// "13:00:54"), is on a 12-hour clock.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn one_pm_is_12_hour(time: &str) -> Option<bool> {
    let hour = time
        .split(|c: char| !c.is_ascii_digit())
        .find(|part| !part.is_empty())?
        .parse::<u8>()
        .ok()?;
    match hour {
        1 => Some(true),
        13 => Some(false),
        _ => None,
    }
}

#[cfg(windows)]
async fn twelve_hour() -> Option<bool> {
    let said = output(
        "reg",
        &[
            "query",
            r"HKCU\Control Panel\International",
            "/v",
            "sShortTime",
        ],
    )
    .await?;
    // `    sShortTime    REG_SZ    h:mm tt`
    let format = said.lines().find_map(|l| l.split("REG_SZ").nth(1))?.trim();
    short_time_is_12_hour(format)
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn twelve_hour() -> Option<bool> {
    let said = output(
        "gsettings",
        &["get", "org.gnome.desktop.interface", "clock-format"],
    )
    .await?;
    match said.trim_matches('\'') {
        "12h" => Some(true),
        "24h" => Some(false),
        _ => None,
    }
}

/// Whether a Windows time format (`h:mm tt`, `HH:mm`) is 12-hour.
#[cfg_attr(not(windows), allow(dead_code))]
fn short_time_is_12_hour(format: &str) -> Option<bool> {
    match (format.contains('h'), format.contains('H')) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        _ => None,
    }
}

/// What `program` prints, trimmed; `None` when it can't run, fails or stalls.
async fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        // No console window flashes up beside the app.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command_output(&mut command, CLOCK_TIMEOUT).await
}

async fn command_output(command: &mut Command, timeout: Duration) -> Option<String> {
    command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Dropping the timed-out output future kills the child as well as
    // releasing startup to use the language's clock.
    let done = tokio::time::timeout(timeout, command.output())
        .await
        .ok()?
        .ok()?;
    done.status
        .success()
        .then(|| String::from_utf8_lossy(&done.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::{Command, Duration, command_output, one_pm_is_12_hour, short_time_is_12_hour};

    /// The deadline for a helper that's meant to finish: far beyond any
    /// slowness, so only a hang outlasts it. A year rather than
    /// `Duration::MAX`, so it can't overflow added to now.
    const NEVER: Duration = Duration::from_secs(365 * 24 * 60 * 60);

    #[test]
    fn the_time_at_13_00_says_which_clock() {
        assert_eq!(one_pm_is_12_hour("1:00:54 PM"), Some(true));
        assert_eq!(one_pm_is_12_hour("1:13:54 PM"), Some(true));
        assert_eq!(one_pm_is_12_hour("01:54:13 PM"), Some(true));
        assert_eq!(one_pm_is_12_hour("PM 1:13:13"), Some(true));
        assert_eq!(one_pm_is_12_hour("13:00:54"), Some(false));
        assert_eq!(one_pm_is_12_hour("13:13:13"), Some(false));
        assert_eq!(one_pm_is_12_hour("2:00:00"), None);
        assert_eq!(one_pm_is_12_hour("unavailable"), None);
        assert_eq!(one_pm_is_12_hour(""), None);
    }

    fn helper(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "clock::tests::helper_process",
                "--ignored",
                "--nocapture",
            ])
            .env("ICMM_CLOCK_TEST_HELPER", mode);
        command
    }

    // A real child on every OS, without depending on a shell or a clock utility.
    #[test]
    #[ignore = "only run as a subprocess by the clock tests"]
    fn helper_process() {
        match std::env::var("ICMM_CLOCK_TEST_HELPER").as_deref() {
            Ok("success") => {
                println!("  1:13:13 PM  ");
                std::process::exit(0);
            }
            Ok("failure") => std::process::exit(1),
            // Until it's killed.
            Ok("stall") => loop {
                std::thread::park();
            },
            _ => panic!("missing clock test helper mode"),
        }
    }

    #[tokio::test]
    async fn helper_output_and_failures() {
        let said = command_output(&mut helper("success"), NEVER).await.unwrap();
        assert!(said.ends_with("1:13:13 PM"));
        assert_eq!(command_output(&mut helper("failure"), NEVER).await, None);
        assert_eq!(
            command_output(&mut Command::new("icmm-missing-clock-helper"), NEVER).await,
            None
        );
    }

    /// On the real clock: the helper never answers, so only the deadline can
    /// end it, however slow the machine. (The paused clock would jump past the
    /// deadline while the child starts, so any helper would fall back.)
    #[tokio::test]
    async fn a_stalled_helper_falls_back_at_the_deadline() {
        let result = command_output(&mut helper("stall"), Duration::from_millis(100)).await;
        assert_eq!(result, None, "the stalled helper must not block startup");
    }

    #[test]
    fn a_windows_time_format_says_which_clock() {
        assert_eq!(short_time_is_12_hour("h:mm tt"), Some(true));
        assert_eq!(short_time_is_12_hour("HH:mm"), Some(false));
        assert_eq!(short_time_is_12_hour("mm:ss"), None);
    }
}
