//! Installing a bundle on an SSH platform, in two execs: every exec there
//! pays the login shell's startup (~7 s on McKelvey), so the connect's own
//! check rides on the exec that starts the agent.
//!
//! 1. The agent's command first tests `<key>/BUNDLE.json`, and says
//!    `icmm:engine-missing` instead of starting when it's absent.
//! 2. A preflight exec reports what the install needs to know
//!    (`preflight.sh`, judged by `preflight::verdict`) and leaves the install
//!    script beside the upload.
//! 3. The install exec takes the archive on stdin, from where a cut upload
//!    stopped, then checks, unpacks, self-checks and commits it
//!    (`install.sh`).
//!
//! Each command runs in the user's login shell, whatever it is, so each
//! starts `sh` with every path quoted as an argument.

/// The agent's first line once its engine is there; anything the login shell
/// printed comes before it.
pub const READY: &str = "icmm:engine-ready";
/// Instead of `READY` when the engine isn't installed.
pub const MISSING: &str = "icmm:engine-missing";
/// The set-aside command's last line once the engine's folder is out of the way.
pub const SET_ASIDE: &str = "icmm:set-aside";

use super::Bundle;

const PREFLIGHT_SH: &str = include_str!("preflight.sh");
const INSTALL_SH: &str = include_str!("install.sh");

/// A path on the host under `data_folder`, quoted for the user's shell.
fn under(data_folder: &str, rest: &str) -> String {
    sh_path(&format!("{}/{rest}", data_folder.trim_end_matches('/')))
}

/// Starts the agent from `<data folder>/engine/<key>/` when it's there.
pub fn agent_command(data_folder: &str, key: &str, interpreter: &str) -> String {
    let script = format!(
        "if [ -f \"$1/BUNDLE.json\" ]; then echo {READY}; exec \"$1/$2\" -I -m icmm agent \
         --serve --data-folder \"$3\"; fi; echo {MISSING}"
    );
    format!(
        "exec sh -c {} sh {} {} {}",
        sh_quote(&script),
        under(data_folder, &format!("{}/{key}", super::FOLDER)),
        sh_quote(interpreter),
        sh_path(data_folder)
    )
}

/// Moves `<data folder>/engine/<key>/` aside, to `.staging-aside-<time>`
/// beside it, so the next start finds the engine missing, then removes it;
/// says `SET_ASIDE` once it's out of the way, or wasn't there. What the
/// removal leaves (open files on NFS) the next install sweeps, as it sweeps
/// every `.staging-*`.
pub fn set_aside_command(data_folder: &str, key: &str) -> String {
    let script = format!(
        "a=\"$1/.staging-aside-$$-$(date +%s)\"; if [ -e \"$1/$2\" ]; then mv \"$1/$2\" \"$a\" || \
         exit 1; fi; echo {SET_ASIDE}; rm -rf \"$a\""
    );
    format!(
        "exec sh -c {} sh {} {}",
        sh_quote(&script),
        under(data_folder, super::FOLDER),
        sh_quote(key)
    )
}

/// The preflight's command; `preflight_script` goes to its stdin.
pub fn preflight_command(data_folder: &str, sha256: &str) -> String {
    format!(
        "exec sh -s -- {} {}",
        under(data_folder, super::FOLDER),
        sh_quote(sha256)
    )
}

pub fn preflight_script() -> String {
    PREFLIGHT_SH.replace("@INSTALL_SH@\n", INSTALL_SH)
}

/// The install's command; `engine`'s archive from byte `offset` goes to its
/// stdin.
pub fn install_command(data_folder: &str, engine: &Bundle, offset: u64) -> String {
    format!(
        "exec sh {} {} {} {} {offset} {} {}",
        under(
            data_folder,
            &format!("{}/.incoming/{}.sh", super::FOLDER, engine.sha256)
        ),
        under(data_folder, super::FOLDER),
        sh_quote(&engine.key),
        sh_quote(&engine.sha256),
        sh_quote(engine.interpreter()),
        engine.archive_bytes
    )
}

/// How an install exec ended, from its last `icmm:` line.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed,
    /// The upload arrived damaged, or the partial upload changed since the
    /// preflight: upload it again.
    Again,
    Failed {
        why: String,
        detail: String,
    },
    /// It said nothing: the connection went, or the script couldn't run.
    Unknown,
}

pub fn outcome(stdout: &str) -> Outcome {
    // What the login shell printed without a newline may come first.
    let said = |line: &str| {
        line.rfind("icmm:")
            .map(|at| line[at + 5..].trim().to_owned())
    };
    let Some(last) = stdout.lines().rev().find_map(said) else {
        return Outcome::Unknown;
    };
    let last = last.as_str();
    if last == "installed" {
        return Outcome::Installed;
    }
    let Some(failed) = last.strip_prefix("failed ") else {
        return Outcome::Unknown;
    };
    let (why, detail) = failed.split_once(' ').unwrap_or((failed, ""));
    match why {
        "damaged" | "moved" => Outcome::Again,
        _ => Outcome::Failed {
            why: why.to_owned(),
            detail: detail.trim().to_owned(),
        },
    }
}

/// Where the engine goes: a platform's Data folder, as the user wrote it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place<'a> {
    /// The platform's name.
    pub platform: &'a str,
    pub folder: &'a str,
}

impl Place<'_> {
    /// The Data folder at the start of a sentence: "Your home folder on
    /// McKelvey HPC" when it's in the home folder, whose quota it shares.
    pub fn sentence_start(&self) -> String {
        let Place { platform, folder } = self;
        if *folder == "~" || folder.starts_with("~/") {
            format!("Your home folder on {platform}")
        } else {
            format!("{folder} on {platform}")
        }
    }
}

/// `path` quoted for a POSIX shell, with a leading `~/` left to expand.
pub fn sh_path(path: &str) -> String {
    if path == "~" {
        return "\"$HOME\"".into();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", sh_quote(rest)),
        None => sh_quote(path),
    }
}

pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
