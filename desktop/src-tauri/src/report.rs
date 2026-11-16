//! Report a problem… (#126): a plain text report saved in Downloads, and
//! ICMM's public issue page opened with its form filled in from the link.
//!
//! The report holds the failure, the versions, the platform's kind and the
//! newest app and agent logs; a failed start's adds the end of its job log
//! and its run. User names on this computer and its platforms are written
//! `user`; host names stay, since they show which cluster failed. A new-issue
//! link can't carry a file, so the logs go only in the file, which the user
//! drags onto the page.

use std::path::{Path, PathBuf};

use crate::wire::types::{ReportFailure, ReportStart};

/// The public repository's issue form (`docs/issue-page/report.yml`).
pub const ISSUE_PAGE: &str = "https://github.com/meschoening/icmm/issues/new";
/// The form's file in that repository's `.github/ISSUE_TEMPLATE/`.
pub const TEMPLATE: &str = "report.yml";
/// The form's fields the link fills, by their ids.
pub const WHAT_HAPPENED: &str = "what-happened";
pub const VERSIONS: &str = "versions";
/// What a new-issue link may come to: browsers and GitHub take about 8 KB.
pub const MAX_LINK: usize = 8000;
/// The most of each log a report holds, from its end.
pub const MAX_LOG_LINES: usize = 10_000;
/// What a user name is written as.
pub const USER: &str = "user";

/// The report's file name, from the page's clock: `icmm-report-<stamp>.txt`,
/// the stamp written `2026-11-12-0914`. Any other stamp is `None`.
pub fn file_name(stamp: &str) -> Option<String> {
    let shaped = stamp.len() == 15
        && stamp.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 || i == 10 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    shaped.then(|| format!("icmm-report-{stamp}.txt"))
}

/// A file in `folder` named `name`, or `name` with `-2`, `-3`… before its
/// extension where one is there already.
pub fn unused(folder: &Path, name: &str) -> PathBuf {
    let path = folder.join(name);
    if !path.exists() {
        return path;
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    (2..)
        .map(|n| folder.join(format!("{stem}-{n}.{ext}")))
        .find(|p| !p.exists())
        .expect("some name is free")
}

/// `text` with every user name in `names` written `user`: as a whole word,
/// so `ada` goes in `/Users/ada/` and `ada@host` but not in `adapter`,
/// and with its case, so a user `max` leaves `Max running starts`.
pub fn redact(text: &str, names: &[String]) -> String {
    let mut names: Vec<&str> = names
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty() && *n != USER)
        .collect();
    // The longest first, so `max` doesn't cut `max.s` short.
    names.sort_by_key(|n| std::cmp::Reverse(n.len()));
    names.dedup();
    let mut out = text.to_owned();
    for name in names {
        out = replace_word(&out, name);
    }
    out
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn replace_word(text: &str, name: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // Where `out` has copied `text` up to.
    let mut copied = 0;
    for (at, _) in text.match_indices(name) {
        let end = at + name.len();
        // A name is a word only where the text around it isn't more of one.
        let before = text[..at].chars().next_back();
        let after = text[end..].chars().next();
        if !before.is_some_and(word) && !after.is_some_and(word) {
            out.push_str(&text[copied..at]);
            out.push_str(USER);
            copied = end;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// The architecture as people name it: `arm64`, `x64`.
pub fn arch(rust: &str) -> &str {
    match rust {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// `ICMM 0.1.0 · engine 0.1.0 · macOS 15.1 on arm64`, without the engine's
/// while none has answered.
pub fn versions(app: &str, engine: Option<&str>, os: &str, arch: &str) -> String {
    let engine = engine.map(|e| format!(" · engine {e}")).unwrap_or_default();
    format!("ICMM {app}{engine} · {os} on {arch}")
}

/// The Active platform's kind, as the panel says it.
pub fn platform(kind: Option<&str>) -> &'static str {
    match kind {
        Some("ssh") => "SSH to a SLURM cluster",
        Some(_) => "This computer",
        None => "No platform",
    }
}

/// A log the report holds: its file name and its last lines.
#[derive(Debug, PartialEq)]
pub struct Log {
    pub name: String,
    pub text: String,
    pub lines: usize,
    /// Its lines in all, of which `lines` are held.
    pub of: usize,
}

/// The newest `app.<date>.log` and `agent.<date>.log` in `dir`, each's last
/// `MAX_LOG_LINES` lines: app's first. A missing folder has none.
pub fn newest_logs(dir: &Path) -> Vec<Log> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .collect();
    ["app", "agent"]
        .iter()
        .filter_map(|prefix| {
            let newest = names
                .iter()
                .filter(|n| {
                    n.strip_prefix(prefix).is_some_and(|r| r.starts_with('.'))
                        && crate::logging::log_date(n).is_some()
                })
                .max()?;
            let bytes = std::fs::read(dir.join(newest)).ok()?;
            Some(tail(
                newest,
                &String::from_utf8_lossy(&bytes),
                MAX_LOG_LINES,
            ))
        })
        .collect()
}

fn tail(name: &str, text: &str, keep: usize) -> Log {
    let all: Vec<&str> = text.lines().collect();
    let from = all.len().saturating_sub(keep);
    Log {
        name: name.to_owned(),
        text: all[from..].join("\n"),
        lines: all.len() - from,
        of: all.len(),
    }
}

/// What the report is about, and what it holds besides the logs.
pub struct Report<'a> {
    pub failure: Option<&'a ReportFailure>,
    pub start: Option<&'a ReportStart>,
    pub versions: &'a str,
    pub platform: &'a str,
    pub logs: &'a [Log],
}

/// The report's text, before user names are written `user`.
pub fn compose(r: &Report) -> String {
    let mut out = String::from(
        "ICMM problem report\n\
         Drag this file onto ICMM's issue page. User names are written `user`; keys, passwords \
         and dataset contents are left out.\n",
    );
    let mut section = |title: &str, body: &str| {
        out.push_str(&format!("\n== {title}\n{}\n", body.trim_end()));
    };
    if let Some(f) = r.failure {
        let body = [Some(f.what.as_str()), f.next.as_deref(), f.raw.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        section("The failure", &body);
    }
    section("Versions", r.versions);
    section("Platform", r.platform);
    if let Some(s) = r.start {
        section("The start", &s.name);
        section("The end of its job log", &s.job_log);
        section("Its run, as submitted", &s.run);
    }
    for log in r.logs {
        let held = if log.lines == log.of {
            format!("{}, {} lines", log.name, log.lines)
        } else {
            format!("{}, its last {} of {} lines", log.name, log.lines, log.of)
        };
        section(&held, &log.text);
    }
    if r.logs.is_empty() {
        section("Logs", "None were found.");
    }
    out
}

/// The issue page's link with its form filled in: the title, What happened
/// and Versions. What happened is cut short, ending `…`, to keep the link
/// within `MAX_LINK`.
pub fn issue_link(title: &str, what_happened: &str, versions: &str) -> String {
    let head = format!(
        "{ISSUE_PAGE}?template={TEMPLATE}&title={}&{VERSIONS}={}&{WHAT_HAPPENED}=",
        encode(title),
        encode(versions)
    );
    let mut link = head;
    let room = MAX_LINK.saturating_sub(link.len());
    let whole = encode(what_happened);
    if whole.len() <= room {
        link.push_str(&whole);
        return link;
    }
    let ellipsis = encode("…");
    let mut used = 0;
    for c in what_happened.chars() {
        let mut buf = [0; 4];
        let e = encode(c.encode_utf8(&mut buf));
        if used + e.len() + ellipsis.len() > room {
            break;
        }
        used += e.len();
        link.push_str(&e);
    }
    link.push_str(&ellipsis);
    link
}

/// What happened, as the link fills it: the failure's lines, the raw one as
/// code, and the platform's kind. The logs stay in the file.
pub fn what_happened(r: &Report) -> String {
    let mut parts = Vec::new();
    if let Some(f) = r.failure {
        parts.push(f.what.clone());
        if let Some(next) = &f.next {
            parts.push(next.clone());
        }
        if let Some(raw) = &f.raw {
            parts.push(format!("```\n{raw}\n```"));
        }
    }
    if let Some(s) = r.start {
        parts.push(format!("On {}.", s.name));
    }
    parts.push(format!("Platform: {}.", r.platform));
    parts.join("\n\n")
}

/// Percent-encodes `s` for a query value: all but `A–Z a–z 0–9 - _ . ~`.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The title the link gives the issue: the failure's sentence, cut to 120
/// characters; none for a report about no one failure.
pub fn title(failure: Option<&ReportFailure>) -> String {
    let Some(f) = failure else {
        return String::new();
    };
    let what = f.what.trim();
    if what.chars().count() <= 120 {
        what.to_owned()
    } else {
        let cut: String = what.chars().take(119).collect();
        format!("{}…", cut.trim_end())
    }
}

/// The OS and its version: `macOS 15.1`, `Windows 10.0.22631`, `Ubuntu
/// 24.04.1 LTS`; the OS alone where it won't say.
pub fn os() -> String {
    os_version().unwrap_or_else(|| {
        match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            "linux" => "Linux",
            other => other,
        }
        .to_owned()
    })
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let out = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let v = String::from_utf8(out.stdout).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| format!("macOS {v}"))
}

#[cfg(windows)]
fn os_version() -> Option<String> {
    use std::os::windows::process::CommandExt;
    // No console window flashes up for it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    windows_version(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_version() -> Option<String> {
    let text = std::fs::read_to_string("/etc/os-release").ok()?;
    os_release(&text)
}

/// `Windows 10.0.22631` from what `ver` says: `Microsoft Windows [Version
/// 10.0.22631.4460]`.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_version(ver: &str) -> Option<String> {
    let v = ver.split("Version ").nth(1)?.split(']').next()?.trim();
    let build: Vec<&str> = v.split('.').take(3).collect();
    (!build.is_empty() && !build[0].is_empty()).then(|| format!("Windows {}", build.join(".")))
}

/// `PRETTY_NAME` from `/etc/os-release`, unquoted.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
fn os_release(text: &str) -> Option<String> {
    let line = text.lines().find_map(|l| l.strip_prefix("PRETTY_NAME="))?;
    let name = line.trim().trim_matches('"').trim_matches('\'').trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// This computer's user names, as its home folder and its environment name
/// them.
pub fn local_names(home: Option<&Path>) -> Vec<String> {
    let mut names: Vec<String> = ["USER", "USERNAME", "LOGNAME"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .collect();
    if let Some(name) = home.and_then(Path::file_name).and_then(|n| n.to_str()) {
        names.push(name.to_owned());
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_report_is_named_for_when_it_was_saved() {
        assert_eq!(
            file_name("2026-11-12-0914").as_deref(),
            Some("icmm-report-2026-11-12-0914.txt")
        );
        for bad in [
            "2026-11-12",
            "2026-11-12-09:14",
            "../../etc-0914",
            "2026_11_12_0914",
            "",
        ] {
            assert_eq!(file_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_second_report_that_minute_takes_the_next_name() {
        let dir = std::env::temp_dir().join(format!("icmm-report-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = "icmm-report-2026-11-12-0914.txt";
        assert_eq!(unused(&dir, name), dir.join(name));
        std::fs::write(dir.join(name), "").unwrap();
        assert_eq!(
            unused(&dir, name),
            dir.join("icmm-report-2026-11-12-0914-2.txt")
        );
        std::fs::write(dir.join("icmm-report-2026-11-12-0914-2.txt"), "").unwrap();
        assert_eq!(
            unused(&dir, name),
            dir.join("icmm-report-2026-11-12-0914-3.txt")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_names_become_user_as_whole_words_only() {
        let text = "/Users/ada/icmm · ada@login1 · C:\\Users\\ada\\logs · \
                    adapter · max_jobs · Max running starts · a.lovelace@c03 \
                    /srv/a.lovelace/icmm-data";
        assert_eq!(
            redact(text, &names(&["ada", "max", "a.lovelace"])),
            "/Users/user/icmm · user@login1 · C:\\Users\\user\\logs · \
             adapter · max_jobs · Max running starts · user@c03 \
             /srv/user/icmm-data"
        );
    }

    #[test]
    fn a_longer_name_goes_before_a_shorter_one_inside_it() {
        assert_eq!(
            redact("ada.l/x and ada", &names(&["ada", "ada.l"])),
            "user/x and user"
        );
    }

    #[test]
    fn a_name_inside_a_longer_word_stays_after_another_match() {
        assert_eq!(redact("maxmax max", &names(&["max"])), "maxmax user");
    }

    #[test]
    fn empty_names_change_nothing() {
        assert_eq!(redact("a b", &names(&["", "  "])), "a b");
    }

    #[test]
    fn versions_read_as_one_line() {
        assert_eq!(
            versions("0.1.0", Some("0.1.0"), "macOS 15.1", arch("aarch64")),
            "ICMM 0.1.0 · engine 0.1.0 · macOS 15.1 on arm64"
        );
        assert_eq!(
            versions("0.1.0", None, "Windows 10.0.22631", arch("x86_64")),
            "ICMM 0.1.0 · Windows 10.0.22631 on x64"
        );
    }

    #[test]
    fn the_platform_is_named_by_its_kind() {
        assert_eq!(platform(Some("ssh")), "SSH to a SLURM cluster");
        assert_eq!(platform(Some("local")), "This computer");
        assert_eq!(platform(None), "No platform");
    }

    #[test]
    fn os_versions_read_from_what_each_os_says() {
        assert_eq!(
            windows_version("\r\nMicrosoft Windows [Version 10.0.22631.4460]\r\n").as_deref(),
            Some("Windows 10.0.22631")
        );
        assert_eq!(windows_version("nothing"), None);
        assert_eq!(
            os_release("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n")
                .as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
        assert_eq!(os_release("ID=x\n"), None);
    }

    fn failure() -> ReportFailure {
        ReportFailure {
            what: "ICMM’s engine didn’t pass its self-check on McKelvey HPC.".into(),
            next: Some("That’s a problem in ICMM, not something you did. Retry once; if it fails again, report it.".into()),
            raw: Some("self-check: libicmm returned 4".into()),
        }
    }

    #[test]
    fn the_newest_app_and_agent_logs_go_in_from_their_end() {
        let dir = std::env::temp_dir().join(format!("icmm-report-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("app.2026-11-11.log"), "old\n").unwrap();
        std::fs::write(dir.join("app.2026-11-12.log"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("agent.2026-11-10.log"), "agent\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a log\n").unwrap();
        let logs = newest_logs(&dir);
        assert_eq!(
            logs,
            vec![
                Log {
                    name: "app.2026-11-12.log".into(),
                    text: "one\ntwo".into(),
                    lines: 2,
                    of: 2
                },
                Log {
                    name: "agent.2026-11-10.log".into(),
                    text: "agent".into(),
                    lines: 1,
                    of: 1
                },
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(newest_logs(&dir), vec![]);
    }

    #[test]
    fn a_long_log_keeps_its_last_lines() {
        let log = tail("app.2026-11-12.log", "1\n2\n3\n4\n5", 2);
        assert_eq!((log.text.as_str(), log.lines, log.of), ("4\n5", 2, 5));
    }

    #[test]
    fn a_report_holds_the_failure_versions_platform_and_logs() {
        let f = failure();
        let logs = [tail("app.2026-11-12.log", "a\nb\nc", 2)];
        let text = compose(&Report {
            failure: Some(&f),
            start: None,
            versions: "ICMM 0.1.0 · macOS 15.1 on arm64",
            platform: "SSH to a SLURM cluster",
            logs: &logs,
        });
        assert!(text.starts_with("ICMM problem report\n"));
        assert!(text.contains(
            "\n== The failure\nICMM’s engine didn’t pass its self-check on McKelvey HPC.\n\
             That’s a problem in ICMM, not something you did. Retry once; if it fails again, report it.\n\
             self-check: libicmm returned 4\n"
        ));
        assert!(text.contains("\n== Versions\nICMM 0.1.0 · macOS 15.1 on arm64\n"));
        assert!(text.contains("\n== Platform\nSSH to a SLURM cluster\n"));
        assert!(text.contains("\n== app.2026-11-12.log, its last 2 of 3 lines\nb\nc\n"));
        assert!(!text.contains("== The start"));
    }

    #[test]
    fn a_failed_starts_report_adds_its_job_log_and_run() {
        let f = ReportFailure {
            what: "Error · exit code 1".into(),
            next: None,
            raw: None,
        };
        let s = ReportStart {
            name: "#214/T12 · start 37".into(),
            job_log: "Traceback\nRuntimeError: the core returned 4\n".into(),
            run: "{\"search_seed\": 7}".into(),
        };
        let text = compose(&Report {
            failure: Some(&f),
            start: Some(&s),
            versions: "v",
            platform: "This computer",
            logs: &[],
        });
        assert!(text.contains("\n== The failure\nError · exit code 1\n\n== Versions"));
        assert!(text.contains("\n== The start\n#214/T12 · start 37\n"));
        assert!(text.contains(
            "\n== The end of its job log\nTraceback\nRuntimeError: the core returned 4\n"
        ));
        assert!(text.contains("\n== Its run, as submitted\n{\"search_seed\": 7}\n"));
        assert!(text.contains("\n== Logs\nNone were found.\n"));
    }

    #[test]
    fn diagnostic_logs_report_has_no_failure_and_no_title() {
        let text = compose(&Report {
            failure: None,
            start: None,
            versions: "v",
            platform: "p",
            logs: &[],
        });
        assert!(!text.contains("== The failure"));
        assert_eq!(title(None), "");
    }

    #[test]
    fn the_link_fills_the_forms_fields() {
        let f = failure();
        let r = Report {
            failure: Some(&f),
            start: None,
            versions: "ICMM 0.1.0 · macOS 15.1 on arm64",
            platform: "SSH to a SLURM cluster",
            logs: &[],
        };
        let link = issue_link(&title(Some(&f)), &what_happened(&r), r.versions);
        assert!(link.starts_with(
            "https://github.com/meschoening/icmm/issues/new?template=report.yml&title=ICMM%E2%80%99s%20engine%20didn%E2%80%99t%20pass"
        ));
        assert!(link.contains(
            "&versions=ICMM%200.1.0%20%C2%B7%20macOS%2015.1%20on%20arm64&what-happened="
        ));
        assert!(link.contains("%60%60%60%0Aself-check%3A%20libicmm%20returned%204%0A%60%60%60"));
        assert!(link.ends_with("Platform%3A%20SSH%20to%20a%20SLURM%20cluster."));
    }

    #[test]
    fn a_long_what_happened_is_cut_to_keep_the_link_short() {
        let long = "é".repeat(5000);
        let link = issue_link("t", &long, "v");
        assert!(link.len() <= MAX_LINK, "{}", link.len());
        assert!(link.ends_with("%C3%A9%E2%80%A6"));
    }

    #[test]
    fn a_long_title_is_cut() {
        let f = ReportFailure {
            what: "x".repeat(200),
            next: None,
            raw: None,
        };
        let t = title(Some(&f));
        assert_eq!(t.chars().count(), 120);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn the_issue_form_has_the_fields_the_link_fills() {
        let form = include_str!("../../../docs/issue-page/report.yml");
        for id in [WHAT_HAPPENED, VERSIONS] {
            assert!(form.contains(&format!("id: {id}\n")), "{id}");
        }
        assert!(form.contains("id: doing\n"));
    }

    #[test]
    fn this_computers_names_come_from_its_home_folder() {
        let names = local_names(Some(Path::new("/Users/someone")));
        assert!(names.contains(&"someone".to_string()));
    }
}
