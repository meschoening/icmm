//! `~/.ssh/config`, for the platform form's "Fill in from `~/.ssh/config`":
//! the hosts it names, and how `ssh` would reach the one the user picks.
//!
//! The menu reads the file's `Host` and `Include` lines itself. `ssh -G`
//! resolves a host exactly as `ssh` does (`Match`, `Include`, `%` tokens);
//! without `ssh` on the PATH, the `ssh2-config` parser stands in
//! (docs/research/rust-ssh.md §5). Only a host the user picked is resolved,
//! since `ssh -G` runs a `Match exec`'s command. What it finds is read once:
//! the platform keeps the values, jump hosts included, and a connect doesn't
//! read the file again (Max, 2026-10-01). The one exception is the user's own
//! Trust and connect, which asks `ssh -G` whether to hash the line it writes.

use std::path::{Path, PathBuf};
use std::time::Duration;

use ssh2_config::{ParseRule, SshConfig};

use super::store::tilde;
use crate::connection::known_hosts::glob;
use crate::wire::types::{JumpHost, SshConfigHost};

/// `ssh -G` can run a `Match exec`'s command, which may hang.
const SSH_G_TIMEOUT: Duration = Duration::from_secs(10);
/// A `ProxyJump` whose first host jumps through itself goes around forever.
const MAX_JUMPS: usize = 8;
/// The keys `ssh` tries when the config names none, which `ssh -G` lists
/// in their place.
const DEFAULT_KEYS: [&str; 7] = [
    "id_rsa",
    "id_ecdsa",
    "id_ecdsa_sk",
    "id_ed25519",
    "id_ed25519_sk",
    "id_xmss",
    "id_dsa",
];

/// The user's `~/.ssh/config`.
pub fn default_file() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("config"))
}

/// The names `Host` lines give in `file` and the files it includes, in file
/// order and each once, leaving out patterns. None when it can't be read.
pub fn hosts(file: &Path) -> Vec<String> {
    let mut names = Vec::new();
    collect_hosts(file, &mut names, 0);
    names
}

/// OpenSSH's limit on `Include`s within `Include`s.
const MAX_INCLUDE_DEPTH: usize = 16;

fn collect_hosts(file: &Path, names: &mut Vec<String>, depth: usize) {
    let Ok(bytes) = std::fs::read(file) else {
        return;
    };
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Some((keyword, args)) = directive(line) else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") {
            for name in args {
                if !name.contains(['*', '?', '!']) && !names.contains(&name) {
                    names.push(name);
                }
            }
        } else if keyword.eq_ignore_ascii_case("include") && depth < MAX_INCLUDE_DEPTH {
            for pattern in args {
                for path in included(&pattern) {
                    collect_hosts(&path, names, depth + 1);
                }
            }
        }
    }
}

/// A config line's keyword and arguments, as `ssh_config` writes them:
/// `Keyword args` or `Keyword=args`, a double-quoted argument kept whole.
/// `None` for a blank line or a comment.
fn directive(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    let mut args = Vec::new();
    let mut arg = String::new();
    let (mut quoted, mut started) = (false, false);
    for c in rest.chars() {
        match c {
            '"' => (quoted, started) = (!quoted, true),
            c if c.is_whitespace() && !quoted => {
                if started {
                    args.push(std::mem::take(&mut arg));
                    started = false;
                }
            }
            c => {
                arg.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(arg);
    }
    Some((line[..end].to_owned(), args))
}

/// The files an `Include` names, sorted as glob(3) sorts them: `~/` is the
/// home folder, and a relative path is in `~/.ssh`.
fn included(pattern: &str) -> Vec<PathBuf> {
    let Some(home) = std::env::home_dir() else {
        return Vec::new();
    };
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if Path::new(pattern).is_absolute() => PathBuf::from(pattern),
        None => home.join(".ssh").join(pattern),
    };
    let mut found = vec![PathBuf::new()];
    for part in path.components() {
        let name = part.as_os_str().to_string_lossy();
        if !name.contains(['*', '?']) {
            found.iter_mut().for_each(|p| p.push(part));
            continue;
        }
        let mut matched = Vec::new();
        for dir in &found {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.') && glob(name.as_bytes(), n.as_bytes()))
                .collect();
            names.sort();
            matched.extend(names.into_iter().map(|n| dir.join(n)));
        }
        found = matched;
    }
    found.into_iter().filter(|p| p.is_file()).collect()
}

fn parse(file: &Path, host: &str) -> Option<ssh2_config::HostParams> {
    match parse_included(file, host, 0) {
        Ok(params) => Some(params),
        Err(e) => {
            tracing::warn!("couldn't read {}: {e}", file.display());
            None
        }
    }
}

/// Resolve includes with the menu's path traversal: ssh2-config treats a
/// Windows drive path as relative. Parse the intervening sections with the
/// library, merging at each include in file order, only within a matching
/// parent Host. An included file doesn't change its parent's Host section.
fn parse_included(
    file: &Path,
    host: &str,
    depth: usize,
) -> Result<ssh2_config::HostParams, String> {
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let rules = ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS;
    let section = |text: &str| {
        SshConfig::default()
            .parse(&mut std::io::Cursor::new(text), rules)
            .map_err(|e| e.to_string())
    };
    let mut params = SshConfig::default().query(host);
    let mut chunk = String::new();
    let mut scope = String::new();
    for line in text.lines() {
        if let Some((keyword, args)) = directive(line) {
            if keyword.eq_ignore_ascii_case("host") {
                scope = format!("{line}\n");
            } else if keyword.eq_ignore_ascii_case("include") {
                let config = section(&chunk)?;
                params.overwrite_if_none(&config.query(host));
                if depth < MAX_INCLUDE_DEPTH
                    && config
                        .get_hosts()
                        .last()
                        .is_some_and(|h| h.intersects(host))
                {
                    for pattern in args {
                        for path in included(&pattern) {
                            params.overwrite_if_none(&parse_included(&path, host, depth + 1)?);
                        }
                    }
                }
                chunk.clone_from(&scope);
                continue;
            }
        }
        chunk.push_str(line);
        chunk.push('\n');
    }
    params.overwrite_if_none(&section(&chunk)?.query(host));
    Ok(params)
}

/// Where a host's options come from.
#[derive(Debug, Clone)]
pub enum Source {
    /// `ssh -G`, with `-F config` when set, which may take up to `limit`
    /// (10 s, the user's own).
    Ssh {
        program: PathBuf,
        config: Option<PathBuf>,
        limit: Duration,
    },
    /// The parser, reading this file.
    File(PathBuf),
}

impl Source {
    /// The user's: `ssh` when it's on the PATH, else the parser on
    /// `~/.ssh/config`. `None` without a home folder.
    pub fn users() -> Option<Source> {
        if let Some(program) = on_path("ssh") {
            return Some(Source::Ssh {
                program,
                config: None,
                limit: SSH_G_TIMEOUT,
            });
        }
        default_file().map(Source::File)
    }
}

/// `program` on the PATH, as `Command` would find it.
fn on_path(program: &str) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        vec![format!("{program}.exe")]
    } else {
        vec![program.to_owned()]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// One host's options, as far as reaching it goes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Options {
    host_name: String,
    port: u16,
    user: String,
    identity_files: Vec<String>,
    proxy_jump: Option<String>,
    proxy_command: Option<String>,
    hash_known_hosts: bool,
}

impl Source {
    /// The options for `host`, with `user` and `port` given as `ssh -l` and
    /// `-p` would give them, over the config's.
    async fn options(
        &self,
        host: &str,
        user: Option<&str>,
        port: Option<u16>,
    ) -> Result<Options, String> {
        match self {
            Source::Ssh {
                program,
                config,
                limit,
            } => {
                let mut command = tokio::process::Command::new(program);
                if let Some(config) = config {
                    command.arg("-F").arg(config);
                }
                command.arg("-G");
                if let Some(user) = user {
                    command.arg("-l").arg(user);
                }
                if let Some(port) = port {
                    command.arg("-p").arg(port.to_string());
                }
                // A host is never an option, whatever it starts with.
                command
                    .arg("--")
                    .arg(host)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true);
                // A GUI app's console child opens a window on Windows unless told not to.
                #[cfg(windows)]
                command.creation_flags(0x0800_0000);
                let out = tokio::time::timeout(*limit, command.output())
                    .await
                    .map_err(|_| {
                        let waited = limit.as_secs();
                        format!("`ssh -G {host}` didn’t finish in {waited} s.")
                    })?
                    .map_err(|e| format!("Couldn’t run `ssh -G {host}`: {e}."))?;
                if !out.status.success() {
                    let said = String::from_utf8_lossy(&out.stderr);
                    let said = said.lines().map(str::trim).rfind(|l| !l.is_empty());
                    return Err(match said {
                        Some(said) => format!("`ssh -G {host}` said: {said}"),
                        None => format!("`ssh -G {host}` failed."),
                    });
                }
                Ok(read_ssh_g(&String::from_utf8_lossy(&out.stdout)))
            }
            Source::File(file) => {
                let params = parse(file, host).unwrap_or_else(|| SshConfig::default().query(host));
                let unsupported =
                    |name: &str| params.unsupported_fields.get(name).map(|a| a.join(" "));
                Ok(Options {
                    host_name: params
                        .host_name
                        .map(|name| name.replace("%h", host).replace("%%", "%"))
                        .unwrap_or_else(|| host.to_owned()),
                    port: port.or(params.port).unwrap_or(22),
                    user: user
                        .map(str::to_owned)
                        .or(params.user)
                        .unwrap_or_else(local_user),
                    identity_files: params
                        .identity_file
                        .unwrap_or_default()
                        .iter()
                        .map(|file| tilde(file))
                        .collect(),
                    proxy_jump: params.proxy_jump.map(|hops| hops.join(",")),
                    proxy_command: unsupported("proxycommand"),
                    hash_known_hosts: unsupported("hashknownhosts")
                        .is_some_and(|v| v.eq_ignore_ascii_case("yes")),
                })
            }
        }
    }

    /// How `ssh` would reach `alias`: its host, port, user and key, and the
    /// hosts it jumps through, each resolved the same way.
    pub async fn resolve(&self, alias: &str) -> Result<SshConfigHost, String> {
        if alias.is_empty() || alias.starts_with('-') || alias.contains(char::is_whitespace) {
            return Err(format!("“{alias}” isn’t a host name."));
        }
        let options = self.options(alias, None, None).await?;
        let defaults = self.default_keys().await;
        let jump = self.jumps(alias, &options, &defaults, 0).await?;
        Ok(SshConfigHost {
            host: options.host_name.clone(),
            port: nonzero(options.port),
            user: options.user.clone(),
            identity_file: key_of(&options, alias, &defaults),
            jump,
        })
    }

    /// The keys `ssh -G` lists for a host no config says anything about:
    /// what stands in for an `IdentityFile` the config doesn't give, written
    /// as this `ssh`, for this user, writes them. None from the parser.
    async fn default_keys(&self) -> Vec<String> {
        let Source::Ssh { program, limit, .. } = self else {
            return Vec::new();
        };
        let bare = Source::Ssh {
            program: program.clone(),
            config: Some(PathBuf::from("none")),
            limit: *limit,
        };
        bare.options("icmm-default-keys", None, None)
            .await
            .map(|o| o.identity_files)
            .unwrap_or_default()
    }

    /// The hosts `options` (`name`'s) jump through, in the order a connect
    /// goes through them. Only the first jump host's own `ProxyJump` counts,
    /// as with `ssh -J`.
    fn jumps<'a>(
        &'a self,
        name: &'a str,
        options: &'a Options,
        defaults: &'a [String],
        depth: usize,
    ) -> crate::connection::transport::BoxFuture<'a, Result<Vec<JumpHost>, String>> {
        Box::pin(async move {
            if let Some(command) = &options.proxy_command
                && command != "none"
            {
                return Err(format!(
                    "Host {name} connects with a ProxyCommand, which ICMM can’t run. Use \
                     ProxyJump in ~/.ssh/config, or enter the details below."
                ));
            }
            let Some(list) = options.proxy_jump.as_deref().filter(|j| *j != "none") else {
                return Ok(Vec::new());
            };
            if depth >= MAX_JUMPS {
                return Err(format!("Host {name}’s ProxyJump goes around in a loop."));
            }
            let mut route = Vec::new();
            for (index, spec) in list.split(',').map(str::trim).enumerate() {
                let hop = parse_jump(spec)
                    .ok_or_else(|| format!("Host {name}’s ProxyJump “{spec}” isn’t a host."))?;
                let options = self
                    .options(&hop.host, hop.user.as_deref(), hop.port)
                    .await?;
                if index == 0 {
                    route.extend(self.jumps(&hop.host, &options, defaults, depth + 1).await?);
                } else if let Some(command) = &options.proxy_command
                    && command != "none"
                {
                    return Err(format!(
                        "Host {} connects with a ProxyCommand, which ICMM can’t run.",
                        hop.host
                    ));
                }
                route.push(JumpHost {
                    identity_file: key_of(&options, &hop.host, defaults),
                    host: options.host_name,
                    port: nonzero(options.port),
                    user: options.user,
                });
            }
            Ok(route)
        })
    }

    /// Whether `ssh` writes known_hosts names hashed for `host` on `port`
    /// (`HashKnownHosts`). No when it can't tell.
    pub async fn hashes_known_hosts(&self, host: &str, port: u16) -> bool {
        self.options(host, None, Some(port))
            .await
            .is_ok_and(|o| o.hash_known_hosts)
    }
}

/// One `ProxyJump` entry: `[user@]host[:port]`, or `ssh://[user@]host[:port]`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct JumpSpec {
    host: String,
    user: Option<String>,
    port: Option<u16>,
}

fn parse_jump(spec: &str) -> Option<JumpSpec> {
    let spec = spec.strip_prefix("ssh://").unwrap_or(spec);
    let (user, rest) = match spec.rsplit_once('@') {
        Some((user, rest)) => (Some(user.to_owned()), rest),
        None => (None, spec),
    };
    // `[::1]:22` brackets an address with colons in it.
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        let (host, after) = inner.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port.parse().ok()?),
            None if after.is_empty() => None,
            None => return None,
        };
        (host, port)
    } else {
        match rest.split_once(':') {
            Some((host, port)) => (host, Some(port.parse().ok()?)),
            None => (rest, None),
        }
    };
    let bad = |s: &str| s.is_empty() || s.starts_with('-') || s.contains(char::is_whitespace);
    if bad(host) || user.as_deref().is_some_and(bad) || port == Some(0) {
        return None;
    }
    Some(JumpSpec {
        host: host.to_owned(),
        user,
        port,
    })
}

/// The options `ssh -G` prints, one `key value` a line.
fn read_ssh_g(text: &str) -> Options {
    let mut options = Options {
        port: 22,
        ..Options::default()
    };
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else {
            continue;
        };
        let value = value.trim();
        match key {
            "hostname" => options.host_name = value.to_owned(),
            "port" => options.port = value.parse().unwrap_or(22),
            "user" => options.user = value.to_owned(),
            "identityfile" => options.identity_files.push(written(value)),
            "proxyjump" => options.proxy_jump = Some(value.to_owned()),
            "proxycommand" => options.proxy_command = Some(value.to_owned()),
            "hashknownhosts" => options.hash_known_hosts = value == "yes",
            _ => {}
        }
    }
    options
}

/// A key file as the form writes it: in the home folder, from `~/`.
fn written(file: &str) -> String {
    if file.starts_with("~/") || file.starts_with("~\\") {
        return format!("~/{}", file[2..].replace('\\', "/"));
    }
    tilde(Path::new(file))
}

/// The key the platform keeps from a host's `IdentityFile`s (`name` is the
/// host as the config names it): none when they're only `ssh`'s `defaults`
/// (the connect tries those anyway), else the first that exists, else the
/// first. The sentinel `none` isn't a file. Tokens are expanded as `ssh`
/// would; a file with one this can't know is left out.
fn key_of(options: &Options, name: &str, defaults: &[String]) -> Option<String> {
    if !defaults.is_empty() && options.identity_files == defaults {
        return None;
    }
    let files: Vec<String> = options
        .identity_files
        .iter()
        .filter(|f| !f.eq_ignore_ascii_case("none"))
        .filter_map(|f| expand_tokens(f, options, name))
        .collect();
    let default = |file: &String| {
        DEFAULT_KEYS
            .iter()
            .any(|name| *file == format!("~/.ssh/{name}"))
    };
    if files.is_empty() || (files.len() > 1 && files.iter().all(default)) {
        return None;
    }
    let exists = |file: &&String| super::store::expand_home(file).is_file();
    files.iter().find(exists).or(files.first()).cloned()
}

/// `file` with `ssh_config`'s tokens expanded (`%%`, `%d`, `%h`, `%n`, `%p`,
/// `%r`, `%u`), or `None` when it holds one this can't know, such as `%C`.
fn expand_tokens(file: &str, options: &Options, name: &str) -> Option<String> {
    let mut out = String::with_capacity(file.len());
    let mut chars = file.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next()? {
            '%' => out.push('%'),
            'd' => out.push('~'),
            'h' => out.push_str(&options.host_name),
            'n' => out.push_str(name),
            'p' => out.push_str(&options.port.to_string()),
            'r' => out.push_str(&options.user),
            'u' => out.push_str(&local_user()),
            _ => return None,
        }
    }
    Some(out)
}

fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

fn nonzero(port: u16) -> std::num::NonZeroU64 {
    std::num::NonZeroU64::new(port.into()).unwrap_or(std::num::NonZeroU64::MIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The limit for an `ssh -G` that's meant to finish: far beyond any
    /// slowness, so only a hang outlasts it. A year rather than
    /// `Duration::MAX`, so it can't overflow added to now.
    const NEVER: Duration = Duration::from_secs(365 * 24 * 60 * 60);

    #[test]
    fn jump_entries_read_as_ssh_reads_them() {
        let spec = |host: &str, user: Option<&str>, port: Option<u16>| JumpSpec {
            host: host.into(),
            user: user.map(Into::into),
            port,
        };
        assert_eq!(parse_jump("mck"), Some(spec("mck", None, None)));
        assert_eq!(
            parse_jump("me@shell.example.edu:2222"),
            Some(spec("shell.example.edu", Some("me"), Some(2222)))
        );
        assert_eq!(
            parse_jump("ssh://me@shell.example.edu"),
            Some(spec("shell.example.edu", Some("me"), None))
        );
        assert_eq!(parse_jump("[::1]:22"), Some(spec("::1", None, Some(22))));
        assert_eq!(
            parse_jump("a@b@host"),
            Some(spec("host", Some("a@b"), None))
        );
        for bad in [
            "", "host:", "host:x", "host:0", "@host", "[::1", "[::1]x", "a host", "-oX=y",
        ] {
            assert_eq!(parse_jump(bad), None, "{bad}");
        }
    }

    #[test]
    fn ssh_g_output_gives_the_options_that_reach_a_host() {
        let text = "user meschoening\nhostname ws.example.edu\nport 2222\n\
                    hashknownhosts yes\nidentityfile ~/.ssh/id_mck\nidentityfile ~/.ssh/id_rsa\n\
                    proxyjump mck,me@other:22\nforwardagent no\n";
        assert_eq!(
            read_ssh_g(text),
            Options {
                host_name: "ws.example.edu".into(),
                port: 2222,
                user: "meschoening".into(),
                identity_files: vec!["~/.ssh/id_mck".into(), "~/.ssh/id_rsa".into()],
                proxy_jump: Some("mck,me@other:22".into()),
                proxy_command: None,
                hash_known_hosts: true,
            }
        );
    }

    /// A host's options with these `IdentityFile`s, written `~/.ssh/<name>`.
    fn with_keys(names: &[&str]) -> Options {
        Options {
            host_name: "target.example.edu".into(),
            port: 2200,
            user: "tess".into(),
            identity_files: names.iter().map(|n| format!("~/.ssh/{n}")).collect(),
            ..Options::default()
        }
    }

    #[test]
    fn only_a_key_the_config_names_is_kept() {
        // What `ssh -G` lists when the config names no key.
        let defaults = [
            "id_rsa",
            "id_ecdsa",
            "id_ecdsa_sk",
            "id_ed25519",
            "id_ed25519_sk",
        ];
        assert_eq!(key_of(&with_keys(&defaults), "t", &[]), None);
        assert_eq!(key_of(&with_keys(&[]), "t", &[]), None);
        assert_eq!(
            key_of(&with_keys(&["id_ed25519"]), "t", &[]),
            Some("~/.ssh/id_ed25519".into())
        );
        assert_eq!(
            key_of(&with_keys(&["icmm_missing_1", "icmm_missing_2"]), "t", &[]),
            Some("~/.ssh/icmm_missing_1".into())
        );
        // Whatever this `ssh` lists for a host no config names, however it
        // writes it, is no key of the host's own.
        let odd = with_keys(&["../ServiceProfiles/id_rsa", "../ServiceProfiles/id_ecdsa"]);
        assert_eq!(key_of(&odd, "t", &odd.identity_files), None);
    }

    #[test]
    fn a_keys_tokens_are_expanded_as_ssh_would_and_one_it_cant_know_is_left_out() {
        let options = with_keys(&["id_%r@%h_%p_%n%%", "id_%C", "id_%l"]);
        assert_eq!(
            key_of(&options, "target", &[]),
            Some("~/.ssh/id_tess@target.example.edu_2200_target%".into())
        );
        let home = with_keys(&[]);
        assert_eq!(
            expand_tokens("%d/.ssh/x_%u", &home, "t"),
            Some(format!("~/.ssh/x_{}", local_user()))
        );
        assert_eq!(expand_tokens("trailing%", &home, "t"), None);
    }

    /// A config in `dir`, with its hosts' keys and an include.
    fn config(dir: &Path, text: &str) -> PathBuf {
        let file = dir.join("config");
        std::fs::write(&file, text).unwrap();
        file
    }

    #[test]
    fn the_hosts_menu_lists_names_not_patterns_including_included_files() {
        let dir = tempfile::tempdir().unwrap();
        let included = dir.path().join("lab.conf");
        std::fs::write(
            &included,
            "Host silva-ws lab-*\n  HostName silva-ws.example.edu\n",
        )
        .unwrap();
        let more = dir.path().join("config.d");
        std::fs::create_dir(&more).unwrap();
        std::fs::write(more.join("b.conf"), "host=\"quoted one\" b\n").unwrap();
        std::fs::write(
            more.join("a.conf"),
            format!("Include \"{}\"\n", included.display()),
        )
        .unwrap();
        std::fs::write(more.join(".hidden.conf"), "Host hidden\n").unwrap();
        // An absolute path, as Windows writes one too.
        let file = config(
            dir.path(),
            &format!(
                "AddKeysToAgent yes\nInclude {}\n\nHost mckelvey mck\n  HostName shell.example.edu\n\
                 Host *.example.edu !bad.example.edu\n  User me\nHost mck\n  Port 22\n\
                 Match host foo\n  User bar\n# Host commented\nInclude {}\n",
                included.display(),
                more.join("*.conf").display()
            ),
        );

        assert_eq!(
            hosts(&file),
            ["silva-ws", "mckelvey", "mck", "quoted one", "b"]
        );
        assert!(hosts(&dir.path().join("missing")).is_empty());
    }

    /// A config whose `target` jumps through `jump`, which jumps through
    /// `first`, as the fallback parser and `ssh -G` both read it.
    fn jumping_config(dir: &Path) -> PathBuf {
        config(
            dir,
            "Host target\n  HostName target.example.edu\n  User tess\n  Port 2200\n\
             \x20 IdentityFile ~/.ssh/icmm_test_target\n  ProxyJump jump,me@second:2201\n\n\
             Host jump\n  HostName jump.example.edu\n  User jo\n  ProxyJump first\n\n\
             Host first\n  HostName first.example.edu\n  Port 2202\n\n\
             Host second\n  HostName second.example.edu\n  User ignored\n  ProxyJump never\n\n\
             Host pc\n  ProxyCommand ssh -W %h:%p jump\n\n\
             Host loop\n  ProxyJump loop\n",
        )
    }

    fn expected(local: &str) -> SshConfigHost {
        let hop = |host: &str, port: u16, user: &str| JumpHost {
            host: host.into(),
            port: nonzero(port),
            user: user.into(),
            identity_file: None,
        };
        SshConfigHost {
            host: "target.example.edu".into(),
            port: nonzero(2200),
            user: "tess".into(),
            identity_file: Some("~/.ssh/icmm_test_target".into()),
            jump: vec![
                hop("first.example.edu", 2202, local),
                hop("jump.example.edu", 22, "jo"),
                hop("second.example.edu", 2201, "me"),
            ],
        }
    }

    async fn check(source: Source, local: &str) {
        let json = |h: SshConfigHost| serde_json::to_value(h).unwrap();
        assert_eq!(
            json(source.resolve("target").await.unwrap()),
            json(expected(local))
        );
        let pc = source.resolve("pc").await.unwrap_err();
        assert!(pc.contains("ProxyCommand"), "{pc}");
        let looped = source.resolve("loop").await.unwrap_err();
        assert!(looped.contains("loop"), "{looped}");
        assert!(source.resolve("-oProxyCommand=x").await.is_err());
    }

    #[tokio::test]
    async fn the_parser_resolves_a_host_and_its_jump_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let file = jumping_config(dir.path());
        check(Source::File(file), &local_user()).await;
    }

    #[tokio::test]
    async fn the_parser_resolves_absolute_nested_includes_and_jump_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested config");
        std::fs::create_dir(&nested).unwrap();
        let target = jumping_config(&nested);
        let included = dir.path().join("lab.conf");
        std::fs::write(&included, format!("Include \"{}\"\n", target.display())).unwrap();
        let file = config(dir.path(), &format!("Include \"{}\"\n", included.display()));
        assert!(hosts(&file).contains(&"target".to_owned()));
        check(Source::File(file), &local_user()).await;
    }

    #[tokio::test]
    async fn includes_keep_file_order_parent_patterns_and_the_scope_after_returning() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested.conf");
        std::fs::write(&nested, "Host app*\n  Port 2200\n").unwrap();
        let parts = dir.path().join("parts");
        std::fs::create_dir(&parts).unwrap();
        std::fs::write(
            parts.join("a.conf"),
            format!(
                "User included\nInclude \"{}\"\nHost unrelated\n  User leaked\n",
                nested.display()
            ),
        )
        .unwrap();
        std::fs::write(parts.join("b.conf"), "Host app*\n  Port 2400\n").unwrap();
        let last = dir.path().join("last.conf");
        std::fs::write(&last, "IdentityFile ~/.ssh/icmm_test_included\n").unwrap();
        let file = config(
            dir.path(),
            &format!(
                "Host app* !app-bad\n  HostName target.example.edu\n  Include \"{}\" \"{}\"\n\
                 \x20 Port 2300\n  User parent\nHost *\n  User fallback\n  Port 22\n",
                parts.join("*.conf").display(),
                last.display(),
            ),
        );
        let source = Source::File(file.clone());
        let good = source.resolve("app-good").await.unwrap();
        assert_eq!(good.host, "target.example.edu");
        assert_eq!(good.user, "included");
        assert_eq!(good.port, nonzero(2200));
        assert_eq!(good.identity_file, Some("~/.ssh/icmm_test_included".into()));
        for name in ["app-bad", "unrelated"] {
            let skipped = source.resolve(name).await.unwrap();
            assert_eq!(skipped.host, name);
            assert_eq!(skipped.user, "fallback");
            assert_eq!(skipped.port, nonzero(22));
            assert_eq!(skipped.identity_file, None);
        }
        // A Windows PATH can contain an ssh that skips native drive-path
        // Includes. The fallback's native-path assertions above run on every OS.
        #[cfg(unix)]
        if let Some(program) = on_path("ssh") {
            let ssh = Source::Ssh {
                program,
                config: Some(file),
                limit: NEVER,
            };
            for name in ["app-good", "app-bad", "unrelated"] {
                assert_eq!(
                    serde_json::to_value(source.resolve(name).await.unwrap()).unwrap(),
                    serde_json::to_value(ssh.resolve(name).await.unwrap()).unwrap(),
                    "{name}",
                );
            }
        }
    }

    #[test]
    fn include_cycles_stop_at_the_menus_depth_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config");
        config(
            dir.path(),
            &format!("Include \"{}\"\nHost target\n  Port 2200\n", file.display()),
        );
        assert_eq!(hosts(&file), ["target"]);
        assert_eq!(parse(&file, "target").unwrap().port, Some(2200));
    }

    #[test]
    fn identity_file_none_does_not_hide_other_named_files() {
        let options = Options {
            identity_files: vec!["none".into(), "NONE".into(), "~/.ssh/icmm_missing".into()],
            ..with_keys(&[])
        };
        assert_eq!(
            key_of(&options, "target", &[]),
            Some("~/.ssh/icmm_missing".into())
        );
        let literal = Options {
            identity_files: vec!["./none".into()],
            ..options
        };
        assert_eq!(key_of(&literal, "target", &[]), Some("./none".into()));
    }

    #[tokio::test]
    async fn identity_file_none_is_no_named_key_for_both_sources_and_jump_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let file = config(
            dir.path(),
            "Host target\n  HostName target.example.edu\n  User tess\n  IdentityFile none\n  ProxyJump jump\n\
             Host jump\n  HostName jump.example.edu\n  User jo\n  IdentityFile none\n",
        );
        let mut sources = vec![Source::File(file.clone())];
        if let Some(program) = on_path("ssh") {
            sources.push(Source::Ssh {
                program,
                config: Some(file),
                limit: NEVER,
            });
        }
        for source in sources {
            let resolved = source.resolve("target").await.unwrap();
            assert_eq!(resolved.identity_file, None, "{source:?}");
            assert_eq!(resolved.jump.len(), 1);
            assert_eq!(resolved.jump[0].identity_file, None, "{source:?}");
        }
    }

    /// `ssh -G` is OpenSSH's own answer; it isn't on every PATH.
    #[tokio::test]
    async fn ssh_g_resolves_a_host_and_its_jump_hosts() {
        let Some(program) = on_path("ssh") else {
            eprintln!("skipped: no ssh on the PATH");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let file = jumping_config(dir.path());
        let source = Source::Ssh {
            program: program.clone(),
            config: Some(file),
            limit: NEVER,
        };
        // ssh's own idea of the local user, which the first jump host gets.
        let first = source.options("first", None, None).await.unwrap();
        // Shown when the test fails: how this `ssh`, for this user, writes keys.
        eprintln!(
            "{program:?} lists {:?} for first, and {:?} by default",
            first.identity_files,
            source.default_keys().await
        );
        let local = first.user;
        check(source, &local).await;
    }
}
