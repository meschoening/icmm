//! Whether an SSH platform can take the engine, from one exec's report
//! (`preflight.sh`): its OS and CPU, glibc, zstd, and the free space where
//! the engine goes, the smaller of the disk's and the user's quota (ADR-0014).

use super::remote::Place;
use crate::connection::said::Said;
use crate::wire::types::{ConnectFailure, ConnectFix};

/// Why the engine can't go on a platform, and what that needs: a platform
/// that can run it (`Unsupported`), or more space (`NoSpace`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub said: Said,
    pub kind: ConnectFailure,
}

/// A platform the engine can't run on, where retrying can't help.
fn unsupported(reason: &str, next_step: &str, details: String) -> Refusal {
    Refusal {
        said: Said::new(reason, next_step)
            .details(details)
            .fix(ConnectFix::UseThisComputer)
            .no_retry(),
        kind: ConnectFailure::Unsupported,
    }
}

const ELSEWHERE: &str = "Use this computer instead, or another platform.";

/// The oldest glibc the engine runs on: a release build carries only a
/// cluster bundle that needs no newer (`Bundle::runs_on_clusters`).
const GLIBC: (u32, u32) = super::bundle::CLUSTER_GLIBC;

/// What an install needs of the platform.
pub struct Needs<'a> {
    /// `<os>-<arch>`, as the bundle's key spells it.
    pub target: &'a str,
    /// Disk space the install takes while it runs.
    pub bytes: u64,
}

/// The bytes of the archive already on the platform, to resume the upload
/// from, or why the engine can't go there, `at` its Data folder.
pub fn verdict(report: &str, needs: &Needs, at: &Place) -> Result<u64, Refusal> {
    let field = |name: &str| {
        report
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
            .map(str::trim)
    };
    let (os, arch) = expected_uname(needs.target);
    let uname = field("uname").unwrap_or_default();
    if uname != format!("{os} {arch}") {
        let seen = if uname.is_empty() {
            "an unknown system"
        } else {
            uname
        };
        // The same system on another processor, or another system.
        let why = match uname.split_once(' ') {
            Some((their_os, _)) if their_os == os => {
                "Its computers use a kind of processor ICMM doesn’t support"
            }
            _ => "Its computers run a system ICMM doesn’t support",
        };
        return Err(unsupported(
            "ICMM’s engine can’t run on this cluster.",
            &format!("{why}, so retrying won’t help. {ELSEWHERE}"),
            format!("{seen} · ICMM’s engine needs {os} on {arch}"),
        ));
    }
    if os == "Linux" {
        let glibc = field("glibc").unwrap_or_default();
        let needed = format!("ICMM needs glibc {}.{} or newer", GLIBC.0, GLIBC.1);
        match parse_glibc(glibc) {
            Some(version) if version >= GLIBC => {}
            Some(_) => {
                return Err(unsupported(
                    "This cluster’s Linux is too old for ICMM’s engine.",
                    &format!("Retrying won’t help until its admins update it. {ELSEWHERE}"),
                    format!("{glibc} · {needed}"),
                ));
            }
            None => {
                return Err(unsupported(
                    "This cluster’s Linux is a kind ICMM’s engine can’t run on.",
                    &format!("Retrying won’t help. {ELSEWHERE}"),
                    format!("no glibc · {needed}"),
                ));
            }
        }
    }
    if field("zstd") != Some("yes") {
        return Err(Refusal {
            said: Said::new(
                format!(
                    "{} doesn’t have zstd, a tool ICMM needs to unpack its engine.",
                    at.platform
                ),
                "Ask your cluster’s admins to install it, then retry.",
            )
            .details("zstd: command not found"),
            kind: ConnectFailure::Unsupported,
        });
    }
    let part = field("part").and_then(|n| n.parse().ok()).unwrap_or(0u64);
    let quota: Vec<&str> = report
        .lines()
        .filter_map(|line| line.strip_prefix("quota="))
        .collect();
    if let Some(free) = field("df").and_then(|df| free_space(df, &quota)) {
        let needed = needs.bytes.saturating_sub(part);
        if free < needed {
            let (free_mb, needed_mb) = (free / MB, needed.div_ceil(MB));
            return Err(Refusal {
                said: Said::new(
                    format!("{} is too full for ICMM’s engine.", at.sentence_start()),
                    format!(
                        "Free up {} MB there, then retry. Your cluster’s admins can say how big \
                         your quota is.",
                        needed_mb - free_mb
                    ),
                )
                .details(format!(
                    "{} · {free_mb} MB free · the engine needs {needed_mb} MB",
                    at.folder
                )),
                kind: ConnectFailure::NoSpace,
            });
        }
    }
    Ok(part)
}

const MB: u64 = 1_000_000;

/// What `uname -sm` prints where a bundle's target runs.
fn expected_uname(target: &str) -> (&'static str, &str) {
    let (os, arch) = target.split_once('-').unwrap_or((target, ""));
    let os = match os {
        "macos" => "Darwin",
        "windows" => "Windows",
        _ => "Linux",
    };
    (os, arch)
}

/// `glibc 2.34` → (2, 34).
fn parse_glibc(text: &str) -> Option<(u32, u32)> {
    let (major, minor) = text.strip_prefix("glibc ")?.split_once('.')?;
    let minor = minor.split(|c: char| !c.is_ascii_digit()).next()?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// The smaller of what `df -Pk` says is available and what the user's quota
/// leaves on that filesystem, in bytes, as `icmm.folders.free_space` reads it.
fn free_space(df: &str, quota: &[&str]) -> Option<u64> {
    let fields: Vec<&str> = df.split_whitespace().collect();
    let source = *fields.first()?;
    let available = fields.get(3)?.parse::<u64>().ok()? * 1024;
    let left = quota.iter().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 || fields[0] != source {
            return None;
        }
        let number = |i: usize| fields[i].trim_end_matches('*').parse::<u64>().ok();
        let (used, soft, hard) = (number(1)?, number(2)?, number(3)?);
        let limit = [soft, hard].into_iter().filter(|&l| l > 0).min()?;
        Some(limit.saturating_sub(used) * 1024)
    });
    Some(left.map_or(available, |left| left.min(available)))
}
