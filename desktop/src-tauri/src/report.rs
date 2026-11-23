//! Report a problem… (#126): a plain text report saved in Downloads, and
//! ICMM's public issue page opened with its form filled in from the link.
//!
//! The report holds the failure, the versions, the platform's kind and the
//! newest app and agent logs; one from a page adds the page (#470): a
//! start's the end of its job log and its run, a topology's or a run's its
//! run, another page its name. User names on this computer and its platforms are written
//! `user`, and this computer's own host name `this computer`; a cluster's
//! host names stay, since they show which cluster failed.
//!
//! A new-issue link carries at most `MAX_LINK` bytes, so the issue gets a
//! trimmed report (#546, #552): What happened holds the failure, the page and
//! the platform, and The report its raw line, its run, the end of its job log
//! and the newest warnings and errors, cut from the lowest part up to fit. The
//! whole report, its agent log's `ok` requests counted by method, goes on the
//! clipboard to paste at the end, within what an issue holds.

use std::path::{Path, PathBuf};

use crate::wire::types::{ReportFailure, ReportPage, ReportPageKind};

/// The public repository's issue form (`docs/issue-page/report.yml`).
pub const ISSUE_PAGE: &str = "https://github.com/meschoening/icmm/issues/new";
/// The form's file in that repository's `.github/ISSUE_TEMPLATE/`.
pub const TEMPLATE: &str = "report.yml";
/// The form's fields the link fills, by their ids.
pub const WHAT_HAPPENED: &str = "what-happened";
pub const VERSIONS: &str = "versions";
pub const REPORT: &str = "report";
/// What a new-issue link may come to, encoded: GitHub takes 8,191 bytes from
/// a signed-in browser (#550), less 1,000 for a heavier cookie jar.
pub const MAX_LINK: usize = 7_191;
/// The most of a start's job log The report holds, from its end.
pub const JOB_LOG_LINES: usize = 20;
/// The most warning and error lines The report holds, the newest, each cut to
/// `LINE_CHARS` characters.
pub const LOG_LINES: usize = 16;
pub const LINE_CHARS: usize = 160;
/// The most characters the whole report on the clipboard comes to: an issue
/// holds 65,536 in all, with room left for the form's fields and the user's
/// words.
pub const MAX_WHOLE: usize = 55_000;
/// The most of each log a report holds, from its end.
pub const MAX_LOG_LINES: usize = 10_000;
/// What a user name is written as.
pub const USER: &str = "user";
/// What this computer's host name is written as.
pub const THIS_COMPUTER: &str = "this computer";

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
        out = replace_word(&out, name, USER);
    }
    out
}

/// `text` with this computer's host names in `hosts` written `this
/// computer`, as whole words: a report from This computer otherwise names
/// the user's machine in a public issue (#505). They're matched as written,
/// as `hostname` and the engine both write them, so a host `ubuntu` leaves
/// `Ubuntu 24.04`; `localhost` names no one and stays.
pub fn redact_hosts(text: &str, hosts: &[String]) -> String {
    let mut hosts: Vec<&str> = hosts
        .iter()
        .map(|h| h.trim())
        .filter(|h| !h.is_empty() && *h != "localhost")
        .collect();
    hosts.sort_by_key(|h| std::cmp::Reverse(h.len()));
    hosts.dedup();
    let mut out = text.to_owned();
    for host in hosts {
        out = replace_word(&out, host, THIS_COMPUTER);
    }
    out
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `text` with `name` written `with` wherever it stands as a word.
fn replace_word(text: &str, name: &str, with: &str) -> String {
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
            out.push_str(with);
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
    pub page: Option<&'a ReportPage>,
    pub versions: &'a str,
    pub platform: &'a str,
    pub logs: &'a [Log],
}

/// The page's section, by its kind.
fn page_title(kind: ReportPageKind) -> &'static str {
    match kind {
        ReportPageKind::Start => "The start",
        ReportPageKind::Topology => "The topology",
        ReportPageKind::Run => "The run",
        ReportPageKind::Page => "The page",
    }
}

/// The report's text, as it's saved in Downloads.
pub fn compose(r: &Report) -> String {
    let logs: Vec<(String, String)> = r
        .logs
        .iter()
        .map(|l| (held(&l.name, l.lines, l.of), l.text.clone()))
        .collect();
    compose_logs(r, &logs)
}

/// A log's section title: its name and the lines it holds.
fn held(name: &str, lines: usize, of: usize) -> String {
    if lines == of {
        format!("{name}, {lines} lines")
    } else {
        format!("{name}, its last {lines} of {of} lines")
    }
}

/// The report's text, with each log as its title and its body.
fn compose_logs(r: &Report, logs: &[(String, String)]) -> String {
    let mut out = String::from(
        "ICMM problem report\n\
         User names are written `user`; keys, passwords and dataset contents are left out.\n",
    );
    // A section with nothing in it says so, where a blank one read as lost (an
    // ended start's job log that it wrote nothing to, WB5-2).
    let mut section = |title: &str, body: &str| {
        let body = match body.trim_end() {
            "" => "(empty)",
            body => body,
        };
        out.push_str(&format!("\n== {title}\n{body}\n"));
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
    if let Some(p) = r.page {
        section(page_title(p.kind), &p.name);
        if let Some(log) = &p.job_log {
            section("The end of its job log", log);
        }
        if let Some(run) = &p.run {
            section("The run, as submitted", run);
        }
    }
    for (title, body) in logs {
        section(title, body);
    }
    if logs.is_empty() {
        section("Logs", "None were found.");
    }
    out
}

/// The issue page's link with its form filled in: the title, Versions,
/// What happened and The report, within `MAX_LINK` encoded. The report's
/// parts go in in order while they fit, so the lowest is cut first; What
/// happened is cut short, ending `…`, only where it alone won't fit.
pub fn issue_link(r: &Report) -> String {
    let mut link = format!(
        "{ISSUE_PAGE}?template={TEMPLATE}&title={}&{VERSIONS}={}&{WHAT_HAPPENED}=",
        encode(&title(r.failure)),
        encode(r.versions)
    );
    let room = MAX_LINK.saturating_sub(link.len());
    let what = what_happened(r);
    let key = format!("&{REPORT}=");
    let whole = encode(&what);
    if whole.len() + key.len() > room {
        link.push_str(&encode(&cut(&what, room)));
        return link;
    }
    link.push_str(&whole);
    let report = fill(&report_parts(r), room - whole.len() - key.len());
    if !report.is_empty() {
        link.push_str(&key);
        link.push_str(&encode(&report));
    }
    link
}

/// What happened, as the link fills it: the failure's words, the page and
/// the platform's kind. Its raw line goes in The report.
pub fn what_happened(r: &Report) -> String {
    let mut parts = Vec::new();
    if let Some(f) = r.failure {
        parts.push(f.what.clone());
        if let Some(next) = &f.next {
            parts.push(next.clone());
        }
    }
    if let Some(p) = r.page {
        parts.push(format!("On {}.", p.name));
    }
    parts.push(format!("Platform: {}.", r.platform));
    parts.join("\n\n")
}

/// A part of The report: its title and what it holds.
struct Part {
    title: &'static str,
    body: Body,
}

enum Body {
    /// Cut short from its end, ending `…`.
    Text(String),
    /// Cut by its oldest lines.
    Lines(Vec<String>),
}

/// The report's parts, highest first: the raw line, the run, the end of the
/// job log and the newest warnings and errors.
fn report_parts(r: &Report) -> Vec<Part> {
    let mut parts = Vec::new();
    if let Some(raw) = r.failure.and_then(|f| f.raw.as_deref()) {
        let raw = raw.trim_end();
        if !raw.is_empty() {
            parts.push(Part {
                title: "The raw line",
                body: Body::Text(unfenced(raw)),
            });
        }
    }
    if let Some(p) = r.page {
        if let Some(run) = &p.run {
            parts.push(Part {
                title: "The run, as submitted",
                body: Body::Text(unfenced(&compact(run))),
            });
        }
        if let Some(log) = &p.job_log {
            let lines: Vec<&str> = log.trim_end().lines().collect();
            let lines = match &lines[lines.len().saturating_sub(JOB_LOG_LINES)..] {
                [] => vec!["(empty)".to_owned()],
                lines => lines.iter().map(|l| unfenced(l)).collect(),
            };
            parts.push(Part {
                title: "The end of its job log",
                body: Body::Lines(lines),
            });
        }
    }
    let warnings = warnings(r.logs);
    if !warnings.is_empty() {
        parts.push(Part {
            title: "The newest warnings and errors",
            body: Body::Lines(warnings.iter().map(|l| unfenced(l)).collect()),
        });
    }
    parts
}

/// The report's parts, in order, while they fit in `room` bytes encoded:
/// the part that doesn't fit is cut, its text short or its oldest lines left
/// out, and none below it goes in.
fn fill(parts: &[Part], room: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for part in parts {
        let head = format!(
            "{}== {}\n",
            if out.is_empty() { "" } else { "\n\n" },
            part.title
        );
        let head_len = encode(&head).len();
        // A part's head with nothing under it says nothing.
        let Some(left) = room.checked_sub(used + head_len).filter(|&n| n > 0) else {
            break;
        };
        let (body, whole) = match &part.body {
            Body::Text(text) if encode(text).len() <= left => (text.clone(), true),
            Body::Text(text) => (cut(text, left), false),
            Body::Lines(lines) => {
                // The newest lines that fit, each with its newline but the last.
                let mut cost = 0;
                let kept = lines
                    .iter()
                    .rev()
                    .enumerate()
                    .take_while(|(i, l)| {
                        cost += encode(l).len() + if *i == 0 { 0 } else { 3 };
                        cost <= left
                    })
                    .count();
                let from = lines.len() - kept;
                (lines[from..].join("\n"), from == 0)
            }
        };
        if body.is_empty() || body == "…" {
            break;
        }
        used += head_len + encode(&body).len();
        out.push_str(&head);
        out.push_str(&body);
        if !whole {
            break;
        }
    }
    out
}

/// `text`'s first characters, ending `…`, that come to `room` bytes or fewer
/// encoded.
fn cut(text: &str, room: usize) -> String {
    let ellipsis = encode("…").len();
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        let mut buf = [0; 4];
        let e = encode(c.encode_utf8(&mut buf)).len();
        if used + e + ellipsis > room {
            break;
        }
        used += e;
        out.push(c);
    }
    out.push('…');
    out
}

/// `text` with each line that would end the form's code block (three
/// backticks after at most three spaces) kept from doing so by a zero-width
/// space before its backticks.
fn unfenced(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let indent = line.len() - line.trim_start_matches(' ').len();
            if indent <= 3 && line[indent..].starts_with("```") {
                format!("{}\u{200B}{}", &line[..indent], &line[indent..])
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// JSON with the white space between its tokens taken out, its keys in their
/// order.
fn compact(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    let (mut quoted, mut escaped) = (false, false);
    for c in json.trim().chars() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if !c.is_whitespace() {
            quoted = c == '"';
            out.push(c);
        }
    }
    out
}

/// A log's lines grouped by entry: a line with a timestamp starts one, and
/// the lines after it without one (a traceback) go with it.
fn entries(text: &str) -> Vec<(&str, Vec<&str>)> {
    let mut out: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match stamp_of(line) {
            Some(stamp) => out.push((stamp, vec![line])),
            None => match out.last_mut() {
                Some((_, lines)) => lines.push(line),
                None => out.push(("", vec![line])),
            },
        }
    }
    out
}

/// The timestamp a log line starts with, as both logs write it:
/// `2026-11-20T09:00:07.123Z`.
fn stamp_of(line: &str) -> Option<&str> {
    let stamp = line.split(' ').next()?;
    let b = stamp.as_bytes();
    (b.len() >= 20 && b[4] == b'-' && b[10] == b'T' && b[0].is_ascii_digit()).then_some(stamp)
}

/// An agent log's request line, `<when> <method> id=<id> <n> ms <outcome>`:
/// its method and how it ended.
fn request(line: &str) -> Option<(&str, &str)> {
    let mut words = line.split_whitespace().skip(1);
    let (method, id, _, ms, outcome) = (
        words.next()?,
        words.next()?,
        words.next()?,
        words.next()?,
        words.next()?,
    );
    (id.starts_with("id=") && ms == "ms" && words.next().is_none()).then_some((method, outcome))
}

/// An agent log's request that answered `ok`: `<when> <method> id=<id> <n> ms ok`.
fn ok_request<'a>(entry: &[&'a str]) -> Option<&'a str> {
    let [line] = entry else {
        return None;
    };
    request(line).and_then(|(method, outcome)| (outcome == "ok").then_some(method))
}

/// How many of an entry's lines are the agent's: its stamped line, an
/// `internal` reply's `log_ref=`, and each Python traceback to its
/// exception's line. Lines after those are another program's.
fn agents_lines(stamp: &str, lines: &[&str]) -> usize {
    let mut kept = usize::from(!stamp.is_empty());
    let mut traceback = false;
    for (i, line) in lines.iter().enumerate().skip(kept) {
        if line.starts_with("Traceback (most recent call last):") {
            traceback = true;
        } else if traceback {
            // A frame is indented; the exception's line, which ends it, isn't.
            traceback = line.starts_with([' ', '\t']);
        } else if !line.starts_with("log_ref=") {
            continue;
        }
        kept = i + 1;
    }
    kept
}

/// An agent log's warnings and errors: every entry but a request that
/// answered `ok`, or `not_found` (a page still open on what's gone, #556),
/// whose lines after it stay. The lines without a timestamp just before an
/// agent's `hello`, its first request, are its login shell's startup files'
/// (`agents_lines`), not the agent's.
fn agent_warnings(text: &str) -> Vec<(&str, Vec<&str>)> {
    let mut all = entries(text);
    for i in 1..all.len() {
        if all[i]
            .1
            .first()
            .and_then(|l| request(l))
            .is_some_and(|(m, _)| m == "hello")
        {
            let (stamp, lines) = &mut all[i - 1];
            lines.truncate(agents_lines(stamp, lines));
        }
    }
    for (stamp, lines) in &mut all {
        if !stamp.is_empty() && matches!(request(lines[0]), Some((_, "ok" | "not_found"))) {
            lines.remove(0);
        }
    }
    all.retain(|(_, lines)| !lines.is_empty());
    all
}

fn agent_log(log: &Log) -> bool {
    log.name.starts_with("agent.")
}

/// The newest `LOG_LINES` warning and error lines across the logs, oldest
/// first, each cut to `LINE_CHARS`: the app log's `WARN` and `ERROR`
/// entries, and the agent log's warnings (`agent_warnings`).
fn warnings(logs: &[Log]) -> Vec<String> {
    let mut kept: Vec<(&str, Vec<&str>)> = Vec::new();
    for log in logs {
        if agent_log(log) {
            kept.extend(agent_warnings(&log.text));
        } else {
            kept.extend(entries(&log.text).into_iter().filter(|(_, lines)| {
                matches!(lines[0].split_whitespace().nth(1), Some("WARN" | "ERROR"))
            }));
        }
    }
    // Both logs write UTC to the millisecond, so their stamps sort as text.
    kept.sort_by(|a, b| a.0.cmp(b.0));
    let lines: Vec<&str> = kept.into_iter().flat_map(|(_, lines)| lines).collect();
    lines[lines.len().saturating_sub(LOG_LINES)..]
        .iter()
        .map(|l| short(l, LINE_CHARS))
        .collect()
}

/// `line` in at most `chars` characters, ending `…` where it's cut.
fn short(line: &str, chars: usize) -> String {
    if line.chars().count() <= chars {
        return line.to_owned();
    }
    let mut out: String = line.chars().take(chars - 1).collect();
    out.push('…');
    out
}

/// The whole report, for the clipboard: as it's saved, but with the agent
/// log's `ok` requests counted by method, and within `MAX_WHOLE` characters
/// by taking the app log from its end, then the agent log's other lines from
/// theirs, then cutting it short.
pub fn whole(r: &Report) -> String {
    struct Squeezed<'a> {
        log: &'a Log,
        lines: Vec<&'a str>,
        /// An agent log's `ok` requests, counted by method, most first.
        ok: Option<(usize, String)>,
    }
    let squeezed: Vec<Squeezed> = r
        .logs
        .iter()
        .map(|log| {
            if !agent_log(log) {
                return Squeezed {
                    log,
                    lines: log.text.lines().collect(),
                    ok: None,
                };
            }
            let mut counts: Vec<(&str, usize)> = Vec::new();
            let mut lines = Vec::new();
            for (_, entry) in entries(&log.text) {
                match ok_request(&entry) {
                    Some(method) => match counts.iter_mut().find(|(m, _)| *m == method) {
                        Some((_, n)) => *n += 1,
                        None => counts.push((method, 1)),
                    },
                    None => lines.extend(entry),
                }
            }
            counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            let ok = (!counts.is_empty()).then(|| {
                let total = counts.iter().map(|(_, n)| n).sum();
                let each: Vec<String> = counts.iter().map(|(m, n)| format!("{m} {n}")).collect();
                (total, format!("ok requests: {}", each.join(" · ")))
            });
            Squeezed { log, lines, ok }
        })
        .collect();
    let build = |app_cut: usize, agent_cut: usize| {
        let logs: Vec<(String, String)> = squeezed
            .iter()
            .map(|s| {
                let Some((total, counted)) = &s.ok else {
                    let from = app_cut.min(s.lines.len());
                    return (
                        held(&s.log.name, s.log.lines - from, s.log.of),
                        s.lines[from..].join("\n"),
                    );
                };
                let from = agent_cut.min(s.lines.len());
                let mut title = format!(
                    "{}, its {total} ok requests counted by method",
                    held(&s.log.name, s.log.lines, s.log.of)
                );
                if from > 0 {
                    title.push_str(&format!(", its oldest {from} other lines left out"));
                }
                let mut body = s.lines[from..].join("\n");
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(counted);
                (title, body)
            })
            .collect();
        unfenced(&compose_logs(r, &logs))
    };
    let fits = |text: &String| text.chars().count() <= MAX_WHOLE;
    let most = |of: fn(&Squeezed) -> bool| {
        squeezed
            .iter()
            .filter(|s| of(s))
            .map(|s| s.lines.len())
            .max()
            .unwrap_or(0)
    };
    let app_most = most(|s| s.ok.is_none());
    let agent_most = most(|s| s.ok.is_some());
    least(app_most, |n| build(n, 0), fits)
        .or_else(|| least(agent_most, |n| build(app_most, n), fits))
        .unwrap_or_else(|| short(&build(app_most, agent_most), MAX_WHOLE))
}

/// What `build` makes of the fewest `n` in `0..=most` that `fits`, where
/// every `n` past one that fits fits too; none where `most` doesn't.
fn least(
    most: usize,
    build: impl Fn(usize) -> String,
    fits: impl Fn(&String) -> bool,
) -> Option<String> {
    let last = build(most);
    if !fits(&last) {
        return None;
    }
    let (mut lo, mut hi, mut best) = (0, most, last);
    while lo < hi {
        let mid = (lo + hi) / 2;
        let text = build(mid);
        if fits(&text) {
            hi = mid;
            best = text;
        } else {
            lo = mid + 1;
        }
    }
    Some(best)
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

/// This computer's host names: what `hostname` says, which is what its
/// engine's hello and logs write, the environment's, and each without its
/// domain (`Adas-MacBook-Air` of `Adas-MacBook-Air.local`).
pub fn local_hosts() -> Vec<String> {
    let mut hosts: Vec<String> = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .collect();
    hosts.extend(host_name());
    let short: Vec<String> = hosts
        .iter()
        .filter_map(|h| h.split_once('.').map(|(name, _)| name.to_owned()))
        .collect();
    hosts.extend(short);
    hosts
}

fn host_name() -> Option<String> {
    // Linux's own record, where `hostname` may not be installed.
    #[cfg(target_os = "linux")]
    if let Ok(name) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
        let name = name.trim();
        if !name.is_empty() {
            return Some(name.to_owned());
        }
    }
    let mut command = std::process::Command::new("hostname");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashes up for it.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command.output().ok().filter(|o| o.status.success())?;
    let name = String::from_utf8(out.stdout).ok()?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
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
    fn this_computers_host_name_becomes_this_computer() {
        let hosts = names(&["Adas-MacBook-Air.local", "Adas-MacBook-Air", "DESKTOP-AB12"]);
        assert_eq!(
            redact_hosts(
                "This computer: engine 1.0.0 on Adas-MacBook-Air.local (protocol 1.0) · \
                 coordinator Adas-MacBook-Air:4123 · DESKTOP-AB12 · DESKTOP-AB123 · \
                 login1.cluster.example.edu · localhost",
                &hosts
            ),
            "This computer: engine 1.0.0 on this computer (protocol 1.0) · \
             coordinator this computer:4123 · this computer · DESKTOP-AB123 · \
             login1.cluster.example.edu · localhost"
        );
        assert_eq!(
            redact_hosts("on localhost", &names(&["localhost", ""])),
            "on localhost"
        );
    }

    #[test]
    fn a_host_named_like_the_os_leaves_the_os_named() {
        assert_eq!(
            redact_hosts(
                "ICMM 1.0.0 · Ubuntu 24.04.1 LTS on x64 · ubuntu:4123",
                &names(&["ubuntu"])
            ),
            "ICMM 1.0.0 · Ubuntu 24.04.1 LTS on x64 · this computer:4123"
        );
    }

    #[test]
    fn this_computers_host_names_include_each_without_its_domain() {
        let hosts = local_hosts();
        for h in hosts.iter().filter(|h| h.contains('.')) {
            assert!(hosts.contains(&h.split('.').next().unwrap().to_owned()));
        }
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
            page: None,
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
        let s = ReportPage {
            kind: ReportPageKind::Start,
            name: "start 37 of #214/T12.3".into(),
            job_log: Some("Traceback\nRuntimeError: the core returned 4\n".into()),
            run: Some("{\"search_seed\": 7}".into()),
        };
        let text = compose(&Report {
            failure: Some(&f),
            page: Some(&s),
            versions: "v",
            platform: "This computer",
            logs: &[],
        });
        assert!(text.contains("\n== The failure\nError · exit code 1\n\n== Versions"));
        assert!(text.contains("\n== The start\nstart 37 of #214/T12.3\n"));
        assert!(text.contains(
            "\n== The end of its job log\nTraceback\nRuntimeError: the core returned 4\n"
        ));
        assert!(text.contains("\n== The run, as submitted\n{\"search_seed\": 7}\n"));
        assert!(text.contains("\n== Logs\nNone were found.\n"));
    }

    #[test]
    fn an_empty_job_log_says_so() {
        let s = ReportPage {
            kind: ReportPageKind::Start,
            name: "start 3 of #1/T0.3".into(),
            job_log: Some(String::new()),
            run: None,
        };
        let text = compose(&Report {
            failure: None,
            page: Some(&s),
            versions: "v",
            platform: "This computer",
            logs: &[],
        });
        assert!(text.contains("\n== The end of its job log\n(empty)\n"));
    }

    #[test]
    fn diagnostic_logs_report_has_no_failure_and_no_title() {
        let text = compose(&Report {
            failure: None,
            page: None,
            versions: "v",
            platform: "p",
            logs: &[],
        });
        assert!(!text.contains("== The failure"));
        assert_eq!(title(None), "");
    }

    #[test]
    fn a_report_from_a_page_holds_the_page_and_what_it_has() {
        let run = ReportPage {
            kind: ReportPageKind::Run,
            name: "#214 herg-wt-11state".into(),
            job_log: None,
            run: Some("{\"search_seed\": 7}".into()),
        };
        let r = Report {
            failure: None,
            page: Some(&run),
            versions: "v",
            platform: "This computer",
            logs: &[],
        };
        let text = compose(&r);
        assert!(!text.contains("== The failure"));
        assert!(text.contains("\n== The run\n#214 herg-wt-11state\n"));
        assert!(text.contains("\n== The run, as submitted\n{\"search_seed\": 7}\n"));
        assert!(!text.contains("job log"));
        assert_eq!(
            what_happened(&r),
            "On #214 herg-wt-11state.\n\nPlatform: This computer."
        );
        assert_eq!(title(None), "");

        let other = ReportPage {
            kind: ReportPageKind::Page,
            name: "Datasets".into(),
            job_log: None,
            run: None,
        };
        let text = compose(&Report {
            page: Some(&other),
            ..r
        });
        assert!(text.contains("\n== The page\nDatasets\n"));
        assert!(!text.contains("as submitted"));
    }

    /// The link's `key` field, decoded.
    fn field(link: &str, key: &str) -> Option<String> {
        let query = link.split_once('?')?.1;
        let value = query
            .split('&')
            .find_map(|kv| kv.strip_prefix(&format!("{key}=")))?;
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                out.push(u8::from_str_radix(&value[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        Some(String::from_utf8(out).unwrap())
    }

    fn log(name: &str, text: &str) -> Log {
        tail(name, text, MAX_LOG_LINES)
    }

    const APP: &str = "2026-11-20T09:00:01.000000Z  INFO icmm_desktop::active: connected\n\
                       2026-11-20T09:00:03.000000Z  WARN icmm_desktop::active: slow\n\
                       2026-11-20T09:00:05.000000Z ERROR icmm_desktop::engine: the engine failed\n";
    const AGENT: &str = "2026-11-20T09:00:02.000Z list_runs id=1 3 ms ok\n\
                         2026-11-20T09:00:04.000Z get_run id=2 5 ms internal\n\
                         log_ref=abc\n\
                         Traceback (most recent call last):\n\
                         2026-11-20T09:00:06.000Z list_runs id=3 2 ms ok\n\
                         2026-11-20T09:00:07.000Z get_run id=4 2 ms ok\n";

    fn start() -> ReportPage {
        ReportPage {
            kind: ReportPageKind::Start,
            name: "start 37 of #214/T12.3".into(),
            job_log: Some("line 1\nTraceback\nRuntimeError: the core returned 4\n".into()),
            run: Some("{\n  \"run\": 214,\n  \"settings\": { \"name\": \"a b\" },\n  \"search_seed\": 7\n}".into()),
        }
    }

    #[test]
    fn the_link_fills_the_forms_fields() {
        let f = failure();
        let p = start();
        let logs = [
            log("app.2026-11-20.log", APP),
            log("agent.2026-11-20.log", AGENT),
        ];
        let r = Report {
            failure: Some(&f),
            page: Some(&p),
            versions: "ICMM 0.1.0 · macOS 15.1 on arm64",
            platform: "SSH to a SLURM cluster",
            logs: &logs,
        };
        let link = issue_link(&r);
        assert!(link.starts_with(
            "https://github.com/meschoening/icmm/issues/new?template=report.yml&title=ICMM%E2%80%99s%20engine%20didn%E2%80%99t%20pass"
        ));
        assert_eq!(
            field(&link, VERSIONS).unwrap(),
            "ICMM 0.1.0 · macOS 15.1 on arm64"
        );
        assert_eq!(
            field(&link, WHAT_HAPPENED).unwrap(),
            "ICMM’s engine didn’t pass its self-check on McKelvey HPC.\n\n\
             That’s a problem in ICMM, not something you did. Retry once; if it fails again, report it.\n\n\
             On start 37 of #214/T12.3.\n\n\
             Platform: SSH to a SLURM cluster."
        );
        assert_eq!(
            field(&link, REPORT).unwrap(),
            "== The raw line\n\
             self-check: libicmm returned 4\n\n\
             == The run, as submitted\n\
             {\"run\":214,\"settings\":{\"name\":\"a b\"},\"search_seed\":7}\n\n\
             == The end of its job log\n\
             line 1\nTraceback\nRuntimeError: the core returned 4\n\n\
             == The newest warnings and errors\n\
             2026-11-20T09:00:03.000000Z  WARN icmm_desktop::active: slow\n\
             2026-11-20T09:00:04.000Z get_run id=2 5 ms internal\n\
             log_ref=abc\n\
             Traceback (most recent call last):\n\
             2026-11-20T09:00:05.000000Z ERROR icmm_desktop::engine: the engine failed"
        );
    }

    #[test]
    fn the_warnings_leave_out_not_found_replies_and_the_login_shells_lines() {
        // #556, G4: on McKelvey the login shell's startup files write to the
        // agent's stderr before it says hello; a deleted run's open page reads
        // `not_found` until it closes. Neither is a warning.
        let agent = "Loading /project/compute/modules/engrcompute\n\
                     Loading requirement: slurm\n\
                     2026-11-20T09:00:01.000Z hello id=1 40 ms ok\n\
                     2026-11-20T09:00:02.000Z check_folders id=2 12 ms ok\n\
                     Loading /project/compute/modules/engrcompute\n\
                     Loading requirement: slurm\n\
                     2026-11-20T09:00:03.000Z hello id=1 38 ms ok\n\
                     2026-11-20T09:00:04.000Z read_run id=3 2 ms not_found\n\
                     2026-11-20T09:00:05.000Z get_run id=4 5 ms internal\n\
                     log_ref=abc\n\
                     Traceback (most recent call last):\n\
                     2026-11-20T09:00:06.000Z list_runs id=5 2 ms ok\n\
                     Traceback (most recent call last):\n\
                     RuntimeError: the reader died\n\
                     2026-11-20T09:00:07.000Z event subscription=3 too large: 17000000 bytes\n\
                     2026-11-20T09:00:08.000Z get_run id=6 5 ms internal\n\
                     log_ref=def\n\
                     Traceback (most recent call last):\n\
                     \x20 File \"icmm/agent/serve.py\", line 9, in run\n\
                     ValueError: bad\n\
                     Loading /project/compute/modules/engrcompute\n\
                     2026-11-20T09:00:09.000Z hello id=1 41 ms ok\n";
        assert_eq!(
            warnings(&[log("agent.2026-11-20.log", agent)]),
            vec![
                "2026-11-20T09:00:05.000Z get_run id=4 5 ms internal",
                "log_ref=abc",
                "Traceback (most recent call last):",
                "Traceback (most recent call last):",
                "RuntimeError: the reader died",
                "2026-11-20T09:00:07.000Z event subscription=3 too large: 17000000 bytes",
                // An error just before a reconnect keeps its traceback, not the shell's lines.
                "2026-11-20T09:00:08.000Z get_run id=6 5 ms internal",
                "log_ref=def",
                "Traceback (most recent call last):",
                "  File \"icmm/agent/serve.py\", line 9, in run",
                "ValueError: bad",
            ]
        );
    }

    #[test]
    fn a_report_about_no_failure_fills_no_raw_line() {
        let r = Report {
            failure: None,
            page: None,
            versions: "v",
            platform: "This computer",
            logs: &[],
        };
        let link = issue_link(&r);
        assert_eq!(
            field(&link, WHAT_HAPPENED).unwrap(),
            "Platform: This computer."
        );
        assert_eq!(field(&link, REPORT), None);
    }

    #[test]
    fn a_job_log_and_the_warnings_keep_their_newest_lines() {
        let job: String = (1..=30).map(|n| format!("job {n}\n")).collect();
        let app: String = (1..=30)
            .map(|n| {
                format!(
                    "2026-11-20T09:00:{n:02}.000000Z  WARN icmm_desktop::x: w{n} {}\n",
                    "x".repeat(200)
                )
            })
            .collect();
        let p = ReportPage {
            job_log: Some(job),
            run: None,
            ..start()
        };
        let logs = [log("app.2026-11-20.log", &app)];
        let link = issue_link(&Report {
            failure: None,
            page: Some(&p),
            versions: "v",
            platform: "p",
            logs: &logs,
        });
        let report = field(&link, REPORT).unwrap();
        let (job, warnings) = report
            .split_once("\n\n== The newest warnings and errors\n")
            .unwrap();
        let job: Vec<&str> = job.lines().skip(1).collect();
        assert_eq!(job.len(), JOB_LOG_LINES);
        assert_eq!((job[0], *job.last().unwrap()), ("job 11", "job 30"));
        let warnings: Vec<&str> = warnings.lines().collect();
        assert_eq!(warnings.len(), LOG_LINES);
        assert!(warnings[0].contains(" w15 "), "{}", warnings[0]);
        assert!(warnings.last().unwrap().contains(" w30 "));
        assert!(
            warnings
                .iter()
                .all(|w| w.chars().count() == LINE_CHARS && w.ends_with('…'))
        );
    }

    #[test]
    fn a_link_over_its_room_cuts_the_lowest_part_first() {
        let f = failure();
        let p = ReportPage {
            job_log: Some("é\n".repeat(JOB_LOG_LINES)),
            ..start()
        };
        let app: String = (0..200)
            .map(|n| {
                format!(
                    "2026-11-20T09:{:02}:{:02}.000000Z ERROR icmm_desktop::x: {}\n",
                    n / 60,
                    n % 60,
                    "é".repeat(150)
                )
            })
            .collect();
        let logs = [log("app.2026-11-20.log", &app)];
        let link = issue_link(&Report {
            failure: Some(&f),
            page: Some(&p),
            versions: "v",
            platform: "p",
            logs: &logs,
        });
        assert!(link.len() <= MAX_LINK, "{}", link.len());
        assert!(link.len() > MAX_LINK - 1500, "{}", link.len());
        let report = field(&link, REPORT).unwrap();
        // Every part above the warnings is whole; the warnings keep what fits, the newest.
        assert!(report.contains("{\"run\":214,"));
        assert!(report.contains(&"é\n".repeat(JOB_LOG_LINES - 1)));
        let warnings: Vec<&str> = report
            .split_once("== The newest warnings and errors\n")
            .unwrap()
            .1
            .lines()
            .collect();
        assert!(
            !warnings.is_empty() && warnings.len() < LOG_LINES,
            "{}",
            warnings.len()
        );
        assert!(warnings.last().unwrap().starts_with("2026-11-20T09:03:19"));

        // A raw line too long for the room is cut, ending `…`, and nothing below it goes in.
        let f = ReportFailure {
            raw: Some("x".repeat(9000)),
            ..failure()
        };
        let link = issue_link(&Report {
            failure: Some(&f),
            page: Some(&p),
            versions: "v",
            platform: "p",
            logs: &logs,
        });
        assert!(link.len() <= MAX_LINK, "{}", link.len());
        let report = field(&link, REPORT).unwrap();
        assert!(report.starts_with("== The raw line\nxxx"));
        assert!(report.ends_with("x…"));
        assert!(!report.contains("== The run"));
    }

    #[test]
    fn a_long_what_happened_is_cut_to_keep_the_link_short() {
        let f = ReportFailure {
            what: "é".repeat(5000),
            next: None,
            raw: Some("raw".into()),
        };
        let link = issue_link(&Report {
            failure: Some(&f),
            page: None,
            versions: "v",
            platform: "p",
            logs: &[],
        });
        assert!(link.len() <= MAX_LINK, "{}", link.len());
        assert!(link.ends_with("%C3%A9%E2%80%A6"));
        assert_eq!(field(&link, REPORT), None);
    }

    #[test]
    fn a_line_of_three_backticks_cant_end_the_reports_code_block() {
        let f = ReportFailure {
            raw: Some("before\n```\n  ```` x\n    ```\nin `a ``` b`".into()),
            ..failure()
        };
        let r = Report {
            failure: Some(&f),
            page: None,
            versions: "v",
            platform: "p",
            logs: &[],
        };
        let escaped = "before\n\u{200B}```\n  \u{200B}```` x\n    ```\nin `a ``` b`";
        assert_eq!(
            field(&issue_link(&r), REPORT).unwrap(),
            format!("== The raw line\n{escaped}")
        );
        assert!(whole(&r).contains(escaped));
    }

    #[test]
    fn the_whole_report_counts_the_agents_ok_requests_by_method() {
        let f = failure();
        let logs = [
            log("app.2026-11-20.log", APP),
            log("agent.2026-11-20.log", AGENT),
        ];
        let text = whole(&Report {
            failure: Some(&f),
            page: None,
            versions: "v",
            platform: "p",
            logs: &logs,
        });
        assert!(text.starts_with("ICMM problem report\n"));
        assert!(text.contains("\n== The failure\nICMM’s engine didn’t pass"));
        assert!(text.contains(&format!("\n== app.2026-11-20.log, 3 lines\n{APP}")));
        assert!(
            text.ends_with(
                "\n== agent.2026-11-20.log, 6 lines, its 3 ok requests counted by method\n\
             2026-11-20T09:00:04.000Z get_run id=2 5 ms internal\n\
             log_ref=abc\n\
             Traceback (most recent call last):\n\
             ok requests: list_runs 2 · get_run 1\n"
            ),
            "{text}"
        );
    }

    #[test]
    fn the_whole_report_takes_the_app_log_from_its_end_to_fit() {
        let app: String = (0..1000)
            .map(|n| {
                format!(
                    "2026-11-20T09:00:00.000000Z  INFO icmm_desktop::x: line {n} {}\n",
                    "x".repeat(90)
                )
            })
            .collect();
        let logs = [
            log("app.2026-11-20.log", &app),
            log("agent.2026-11-20.log", AGENT),
        ];
        let text = whole(&Report {
            failure: None,
            page: None,
            versions: "v",
            platform: "p",
            logs: &logs,
        });
        let chars = text.chars().count();
        assert!(chars <= MAX_WHOLE && chars > MAX_WHOLE - 200, "{chars}");
        assert!(text.contains(" line 999 "));
        assert!(!text.contains(" line 0 "));
        assert!(text.contains("== app.2026-11-20.log, its last "));
        assert!(text.contains(" of 1000 lines\n"));
        assert!(text.contains("get_run id=2 5 ms internal\n"));

        // However long, it's cut to fit.
        let f = ReportFailure {
            raw: Some("é".repeat(80_000)),
            ..failure()
        };
        let text = whole(&Report {
            failure: Some(&f),
            page: None,
            versions: "v",
            platform: "p",
            logs: &logs,
        });
        assert_eq!(text.chars().count(), MAX_WHOLE);
        assert!(text.ends_with('…'));
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
        for id in [WHAT_HAPPENED, VERSIONS, REPORT] {
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
