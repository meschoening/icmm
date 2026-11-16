//! Host-key checks against OpenSSH's known_hosts files, and the two changes
//! the user can make to them from the app: trusting a host's new key, and
//! forgetting the old key a host no longer has.
//!
//! ssh-key parses each line; the matching is ours, because russh's own check
//! misses `@` markers, globs and negation, reads one file, and fails it whole
//! on one bad key (docs/research/rust-ssh.md §3). The rules are OpenSSH's,
//! so a file `ssh` trusts gets the same verdict here. `@cert-authority`
//! lines are not yet honored.
//!
//! Trusting appends a line in place, as `ssh` does, so a known_hosts that's
//! a link (to a dotfiles folder) stays one. Forgetting rewrites the file it
//! points to beside itself and renames it into place, every other line kept
//! byte for byte. Both hold a lock beside the file, so two copies of the app
//! can't lose each other's change; `ssh` itself takes no lock.

use std::io::Write;
use std::path::{Path, PathBuf};

use hmac::{Hmac, KeyInit, Mac};
use russh::keys::ssh_key::PublicKey;
use russh::keys::ssh_key::known_hosts::{Entry, HostPatterns, KnownHosts, Marker};
use russh::keys::{Algorithm, HashAlg};
use sha1::Sha1;

/// What the known_hosts files say about the key a host presented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// A line records this key for the host.
    Trusted,
    /// A `@revoked` line names this key; no other line can vouch for it.
    Revoked,
    /// The host has another key of the same algorithm on record, first at
    /// `path`, `line` (1-based), which the warning names.
    Changed {
        path: PathBuf,
        line: usize,
        recorded: PublicKey,
    },
    /// Nothing on record for this algorithm: the trust prompt. When the host
    /// has keys of other algorithms on record, `other_types_known` says so,
    /// as OpenSSH's prompt does.
    Unknown { other_types_known: bool },
}

/// Checks the key `host` presented on `port` against `files`. A matching
/// revocation wins over everything, then a line with this key, then one
/// with a same-algorithm key, wherever each sits in the files.
pub fn verdict(files: &[PathBuf], host: &str, port: u16, key: &PublicKey) -> Verdict {
    let mut trusted = false;
    let mut changed = None;
    let mut other_types_known = false;
    for HostLine { path, line, entry } in host_lines(files, &lookup_name(host, port)) {
        let recorded = entry.public_key();
        // Key data only: `PublicKey`'s own equality counts the comment too.
        let same_key = recorded.key_data() == key.key_data();
        match entry.marker() {
            Some(Marker::Revoked) if same_key => return Verdict::Revoked,
            Some(_) => {}
            None if same_key => trusted = true,
            None if recorded.algorithm() == key.algorithm() => {
                changed.get_or_insert(Verdict::Changed {
                    path: path.to_owned(),
                    line,
                    recorded: recorded.clone(),
                });
            }
            None => other_types_known = true,
        }
    }
    if trusted {
        Verdict::Trusted
    } else {
        changed.unwrap_or(Verdict::Unknown { other_types_known })
    }
}

/// The first plain line that records a key of another algorithm than
/// `key`'s for `host` on `port`, with where it is: what a host that now
/// presents `key` had on record. A host that stops offering the key type on
/// record is one whose key changed, as far as the user can tell.
pub fn other_type_on_record(
    files: &[PathBuf],
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Option<(PathBuf, usize, PublicKey)> {
    host_lines(files, &lookup_name(host, port))
        .into_iter()
        .find(|l| l.entry.marker().is_none() && l.entry.public_key().algorithm() != key.algorithm())
        .map(|l| (l.path.to_owned(), l.line, l.entry.public_key().clone()))
}

/// Whether `file` holds a hashed name (`|1|…`): a user who hashes theirs
/// gets the new line hashed too.
pub fn has_hashed_names(file: &Path) -> bool {
    std::fs::read(file).is_ok_and(|bytes| {
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(parse)
            .any(|e| matches!(e.host_patterns(), HostPatterns::HashedName { .. }))
    })
}

/// The files OpenSSH reads by default (`UserKnownHostsFile`), or none when
/// there's no home folder to find them in.
pub fn default_files() -> Vec<PathBuf> {
    std::env::home_dir()
        .map(|home| {
            let ssh = home.join(".ssh");
            vec![ssh.join("known_hosts"), ssh.join("known_hosts2")]
        })
        .unwrap_or_default()
}

/// The host-key algorithms `files` record for `host` on `port`, in file order
/// and each once. The client asks for these first, as OpenSSH's
/// `order_hostkeyalgs` does, so a host known only by its RSA or ECDSA key
/// isn't met with an ed25519 key and a trust prompt.
///
/// An RSA key comes back as the two SHA-2 signature algorithms it can
/// negotiate, never as `ssh-rsa`'s SHA-1 (research §4).
pub fn recorded_algorithms(files: &[PathBuf], host: &str, port: u16) -> Vec<Algorithm> {
    let mut algorithms = Vec::new();
    for HostLine { entry, .. } in host_lines(files, &lookup_name(host, port)) {
        if entry.marker().is_some() {
            continue;
        }
        let negotiated = match entry.public_key().algorithm() {
            Algorithm::Rsa { .. } => vec![
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha512),
                },
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha256),
                },
            ],
            other => vec![other],
        };
        for algorithm in negotiated {
            if !algorithms.contains(&algorithm) {
                algorithms.push(algorithm);
            }
        }
    }
    algorithms
}

/// A key's fingerprint as `ssh` shows it: `SHA256:` and unpadded base64.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// A key's type as `ssh-keygen -l` names it beside a fingerprint.
pub fn algorithm_name(key: &PublicKey) -> String {
    match key.algorithm() {
        Algorithm::Ed25519 => "ED25519".into(),
        Algorithm::Ecdsa { .. } => "ECDSA".into(),
        Algorithm::Rsa { .. } => "RSA".into(),
        Algorithm::Dsa => "DSA".into(),
        Algorithm::SkEd25519 => "ED25519-SK".into(),
        Algorithm::SkEcdsaSha2NistP256 => "ECDSA-SK".into(),
        other => other.as_str().to_ascii_uppercase(),
    }
}

/// Records `key` as `host`'s on `port` at the end of `file`, as `ssh` does
/// when the user accepts a key: one line, its name hashed when `hashed`
/// (`HashKnownHosts`). The file and its folder are made if missing.
pub fn trust(
    file: &Path,
    host: &str,
    port: u16,
    key: &PublicKey,
    hashed: bool,
) -> std::io::Result<()> {
    let name = lookup_name(host, port);
    let name = if hashed { hash_name(&name) } else { name };
    let line = format!(
        "{name} {}\n",
        key.to_openssh().map_err(std::io::Error::other)?
    );
    let _lock = lock(file)?;
    let mut text = std::fs::OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(file)?;
    // A last line without its newline would run into this one.
    let length = text.metadata()?.len();
    let mut out = Vec::new();
    if length > 0 {
        use std::io::{Read, Seek, SeekFrom};
        let mut last = [0u8];
        text.seek(SeekFrom::Start(length - 1))?;
        text.read_exact(&mut last)?;
        if last[0] != b'\n' {
            out.push(b'\n');
        }
    }
    out.extend_from_slice(line.as_bytes());
    text.write_all(&out)?;
    text.sync_all()
}

/// Removes the line that records `recorded` as `host`'s on `port`: line
/// `line` of `file` (1-based) when it still does, else the first that does.
/// Every other line stays as it was. Answers the line removed, or `None`
/// when no line records it any more.
pub fn forget(
    file: &Path,
    line: usize,
    host: &str,
    port: u16,
    recorded: &PublicKey,
) -> std::io::Result<Option<usize>> {
    let _lock = lock(file)?;
    // The file a link points to, so the link stays one.
    let target = std::fs::canonicalize(file)?;
    let bytes = std::fs::read(&target)?;
    let lines: Vec<&[u8]> = bytes.split_inclusive(|&b| b == b'\n').collect();
    let name = lookup_name(host, port);
    let records = |text: &[u8]| {
        parse(&String::from_utf8_lossy(text)).is_some_and(|entry| {
            entry.marker().is_none()
                && names(entry.host_patterns(), &name)
                && entry.public_key().key_data() == recorded.key_data()
        })
    };
    let at = match line.checked_sub(1) {
        Some(index) if lines.get(index).is_some_and(|l| records(l)) => index,
        _ => match lines.iter().position(|l| records(l)) {
            Some(index) => index,
            None => return Ok(None),
        },
    };
    let mut kept = Vec::with_capacity(bytes.len());
    for (index, text) in lines.iter().enumerate() {
        if index != at {
            kept.extend_from_slice(text);
        }
    }
    let dir = target.parent().unwrap_or(Path::new("."));
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    let temporary = dir.join(format!(".{file_name}.icmm-{}.tmp", std::process::id()));
    let written = (|| {
        let mut out = std::fs::File::create(&temporary)?;
        out.write_all(&kept)?;
        out.set_permissions(std::fs::metadata(&target)?.permissions())?;
        out.sync_all()?;
        drop(out);
        std::fs::rename(&temporary, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map(|()| Some(at + 1))
}

/// Holds the lock beside `file` that every change to it takes.
fn lock(file: &Path) -> std::io::Result<std::fs::File> {
    let dir = match file.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    if !dir.exists() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(dir)?;
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(".icmm-known-hosts.lock"))?;
    lock.lock()?;
    Ok(lock)
}

/// `name` hashed as `ssh-keygen -H` and `HashKnownHosts` write it:
/// `|1|<salt>|<HMAC-SHA1(salt, name)>`, base64.
fn hash_name(name: &str) -> String {
    let mut salt = vec![0; 20];
    fastrand::fill(&mut salt);
    let mut mac = Hmac::<Sha1>::new_from_slice(&salt).expect("HMAC takes any key");
    mac.update(name.as_bytes());
    let hash = mac.finalize().into_bytes().into();
    HostPatterns::HashedName { salt, hash }.to_string()
}

/// A known_hosts line that names the host, with where it is.
struct HostLine<'a> {
    path: &'a Path,
    /// 1-based, as editors and `ssh-keygen -R` count.
    line: usize,
    entry: Entry,
}

/// The name OpenSSH looks a host up by (`put_host_port`): the bare host on
/// port 22 and `[host]:port` on any other, so a line for one port never
/// vouches for another. Lowercase, as `ssh` makes the host before it hashes
/// or matches it.
pub fn lookup_name(host: &str, port: u16) -> String {
    let host = host.to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

/// The lines of `files` whose host patterns match `name`, in file order.
fn host_lines<'a>(files: &'a [PathBuf], name: &str) -> Vec<HostLine<'a>> {
    let mut found = Vec::new();
    for path in files {
        // A missing or unreadable file records nothing.
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        // Lossy, so a stray non-UTF-8 byte spoils only its own line.
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            let Some(entry) = parse(line) else {
                continue;
            };
            if names(entry.host_patterns(), name) {
                found.push(HostLine {
                    path,
                    line: index + 1,
                    entry,
                });
            }
        }
    }
    found
}

/// One known_hosts line, or `None` for a blank, comment or unparseable one,
/// which OpenSSH skips too rather than failing the file.
fn parse(line: &str) -> Option<Entry> {
    // ssh-key splits fields on single spaces; OpenSSH takes any run of
    // spaces and tabs, before a field as well as between.
    let line = line
        .split([' ', '\t'])
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    KnownHosts::new(&line).next()?.ok()
}

/// Whether a line's host patterns name `name`, as OpenSSH's
/// `match_hostname` decides: some pattern matches it and no `!` pattern
/// does, with patterns taken in lowercase.
fn names(patterns: &HostPatterns, name: &str) -> bool {
    match patterns {
        HostPatterns::Patterns(patterns) => {
            let mut named = false;
            for pattern in patterns {
                let pattern = pattern.to_ascii_lowercase();
                match pattern.strip_prefix('!') {
                    Some(negated) if glob(negated.as_bytes(), name.as_bytes()) => return false,
                    Some(_) => {}
                    None => named |= glob(pattern.as_bytes(), name.as_bytes()),
                }
            }
            named
        }
        // A hashed name is HMAC-SHA1(salt, name); `verify_slice` compares
        // in constant time.
        HostPatterns::HashedName { salt, hash } => {
            let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(salt) else {
                return false;
            };
            mac.update(name.as_bytes());
            mac.verify_slice(hash).is_ok()
        }
    }
}

/// OpenSSH's `match_pattern`: `*` matches any run of bytes, `?` exactly one,
/// and everything else itself.
pub(crate) fn glob(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    // Where the last `*` was, and how much text it has swallowed so far.
    let mut star = None;
    while t < text.len() {
        match pattern.get(p) {
            Some(b'*') => {
                star = Some((p, t));
                p += 1;
            }
            Some(&c) if c == b'?' || c == text[t] => {
                p += 1;
                t += 1;
            }
            // A mismatch: let the last `*` swallow one more byte and retry.
            _ => match star {
                Some((star_p, star_t)) => {
                    star = Some((star_p, star_t + 1));
                    p = star_p + 1;
                    t = star_t + 1;
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::rand_core::{TryCryptoRng, TryRng};
    use russh::keys::{EcdsaCurve, PrivateKey};
    use std::convert::Infallible;

    /// Test keys need randomness but not a secure source, and russh's own RNG
    /// isn't a dependency of ours.
    struct TestRng(fastrand::Rng);

    impl TryRng for TestRng {
        type Error = Infallible;

        fn try_next_u32(&mut self) -> Result<u32, Infallible> {
            Ok(self.0.u32(..))
        }

        fn try_next_u64(&mut self) -> Result<u64, Infallible> {
            Ok(self.0.u64(..))
        }

        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
            self.0.fill(dst);
            Ok(())
        }
    }

    impl TryCryptoRng for TestRng {}

    fn new_key(algorithm: Algorithm) -> PublicKey {
        let mut rng = TestRng(fastrand::Rng::new());
        PrivateKey::random(&mut rng, algorithm)
            .unwrap()
            .public_key()
            .clone()
    }

    fn ed25519() -> PublicKey {
        new_key(Algorithm::Ed25519)
    }

    fn p256() -> PublicKey {
        new_key(Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        })
    }

    fn p384() -> PublicKey {
        new_key(Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP384,
        })
    }

    /// A fixed 2048-bit key from `ssh-keygen -t rsa`: generating one per
    /// test is slow in a debug build.
    const RSA: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDWTUAUWv++kxgfbtb+booOupqzUXrckUb7KmkST5rQ9ElnHHpvk0hDTdzw5VZokehMWSSXzdh1ibAy28L4TWsWXDGqC9JQJ6gR9fF6h6Lp5AHdnrzkwD3YnrUFH4RWDbcflyRaKl0N9rt/XsmyOJQnOjnvdM73hy/6TGn+4Mhrj+qcoJbbazk7OxqXaGjumKW4t6PzyrGeW6uGkwlS40MgqwgkHiqoRPu9pmcW8YTgYTI1UVjymEgw9F9I+9tJ7KVZd47y8EUNsYjhaqGKU21Y+7cqrQCBEbwAL5N8QOcX/vjOtR7iyToV8pYJyL+wUPYykWMQOAAe8FyeA/Gnfoe5";

    /// A known_hosts line recording `key` for `hosts`.
    fn entry(hosts: &str, key: &PublicKey) -> String {
        format!("{hosts} {}", key.to_openssh().unwrap())
    }

    /// Writes `lines` to `dir/name`, one per line.
    fn write(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    #[test]
    fn a_plain_line_for_the_host_with_this_key_is_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("shell.example.edu", &key)],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
    }

    #[test]
    fn the_default_files_are_the_users_two_known_hosts_files() {
        let ssh = std::env::home_dir().unwrap().join(".ssh");

        assert_eq!(
            default_files(),
            [ssh.join("known_hosts"), ssh.join("known_hosts2")]
        );
    }

    #[test]
    fn missing_and_unreadable_files_record_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let files = [dir.path().join("missing"), dir.path().to_owned()];

        assert_eq!(
            verdict(&files, "shell.example.edu", 22, &ed25519()),
            Verdict::Unknown {
                other_types_known: false
            }
        );
    }

    #[test]
    fn every_file_is_consulted_and_counts_its_own_lines() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let first = write(
            dir.path(),
            "known_hosts",
            &[entry("other.example.edu", &ed25519())],
        );
        let old = ed25519();
        let second = write(
            dir.path(),
            "known_hosts2",
            &[
                entry("login.example.edu", &key),
                entry("shell.example.edu", &old),
            ],
        );
        let files = [dir.path().join("missing"), first, second.clone()];

        assert_eq!(
            verdict(&files, "login.example.edu", 22, &key),
            Verdict::Trusted
        );
        assert_eq!(
            verdict(&files, "shell.example.edu", 22, &key),
            Verdict::Changed {
                path: second,
                line: 2,
                recorded: old
            }
        );
    }

    #[test]
    fn a_bad_line_does_not_hide_the_lines_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let path = dir.path().join("known_hosts");
        let mut text = [
            "completely-unrelated-garbage",
            "shell.example.edu ssh-ed25519",
            "shell.example.edu ssh-ed25519 not*base64",
            "@revoked",
            "!! @@ ## $$",
        ]
        .join("\n")
        .into_bytes();
        text.extend_from_slice(b"\nshell.example.edu ssh-ed25519 \xff\xfe\n");
        text.extend_from_slice(entry("shell.example.edu", &key).as_bytes());
        std::fs::write(&path, text).unwrap();

        assert_eq!(
            verdict(&[path], "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
    }

    #[test]
    fn tabs_and_runs_of_spaces_separate_fields() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let revoked = ed25519();
        let spaced = |line: String| format!("  {}\t", line.replace(' ', " \t  "));
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                spaced(entry("shell.example.edu", &key)),
                spaced(entry("@revoked shell.example.edu", &revoked)),
            ],
        );
        let files = [file];

        assert_eq!(
            verdict(&files, "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
        assert_eq!(
            verdict(&files, "shell.example.edu", 22, &revoked),
            Verdict::Revoked
        );
    }

    #[test]
    fn each_comma_separated_name_on_a_line_matches() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("login1,shell.example.edu,login3", &key)],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
    }

    #[test]
    fn any_of_several_keys_on_record_is_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("shell.example.edu", &ed25519()),
                entry("shell.example.edu", &key),
            ],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
    }

    #[test]
    fn globs_match_and_a_matching_negation_vetoes_the_line() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("!bad.example.edu,*.example.edu", &key),
                entry("login?.example.org", &key),
                entry("[*.example.net]:2222", &key),
            ],
        );
        let files = [file];
        let unknown = Verdict::Unknown {
            other_types_known: false,
        };

        for (host, port) in [
            ("shell.example.edu", 22),
            ("login1.example.org", 22),
            ("shell.example.net", 2222),
        ] {
            assert_eq!(verdict(&files, host, port, &key), Verdict::Trusted);
        }
        for (host, port) in [
            ("bad.example.edu", 22),
            ("example.edu", 22),
            ("login12.example.org", 22),
            ("login.example.org", 22),
            ("shell.example.net", 22),
        ] {
            assert_eq!(verdict(&files, host, port, &key), unknown, "{host}:{port}");
        }
    }

    /// `name` hashed as `ssh-keygen -H` writes it.
    fn hashed(name: &str) -> String {
        let mut salt = vec![0; 20];
        fastrand::Rng::new().fill(&mut salt);
        let mut mac = Hmac::<Sha1>::new_from_slice(&salt).unwrap();
        mac.update(name.as_bytes());
        let hash = mac.finalize().into_bytes().into();
        HostPatterns::HashedName { salt, hash }.to_string()
    }

    #[test]
    fn a_hashed_name_matches_its_host_only() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry(&hashed("shell.example.edu"), &key),
                entry(&hashed("[login.example.edu]:2222"), &key),
            ],
        );
        let files = [file];
        let unknown = Verdict::Unknown {
            other_types_known: false,
        };

        assert_eq!(
            verdict(&files, "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
        assert_eq!(
            verdict(&files, "login.example.edu", 2222, &key),
            Verdict::Trusted
        );
        assert_eq!(verdict(&files, "other.example.edu", 22, &key), unknown);
        assert_eq!(verdict(&files, "login.example.edu", 22, &key), unknown);
    }

    #[test]
    fn host_names_match_whatever_their_case() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let hashed_key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("Shell.Example.EDU", &key),
                entry(&hashed("login.example.edu"), &hashed_key),
            ],
        );
        let files = [file];

        assert_eq!(
            verdict(&files, "SHELL.example.edu", 22, &key),
            Verdict::Trusted
        );
        assert_eq!(
            verdict(&files, "Login.Example.edu", 22, &hashed_key),
            Verdict::Trusted
        );
    }

    #[test]
    fn another_port_matches_only_its_bracketed_name() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("[shell.example.edu]:2222", &key)],
        );
        let files = [file];

        assert_eq!(
            verdict(&files, "shell.example.edu", 2222, &key),
            Verdict::Trusted
        );
        for port in [22, 2200] {
            assert_eq!(
                verdict(&files, "shell.example.edu", port, &key),
                Verdict::Unknown {
                    other_types_known: false
                }
            );
        }
    }

    /// The old app let a bare-host line vouch for any port (research §3).
    #[test]
    fn a_port_22_line_does_not_vouch_for_another_port() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("shell.example.edu", &key)],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 2222, &key),
            Verdict::Unknown {
                other_types_known: false
            }
        );
    }

    #[test]
    fn a_different_key_of_the_same_algorithm_is_changed_and_names_its_line() {
        let dir = tempfile::tempdir().unwrap();
        let old = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                "# McKelvey".into(),
                String::new(),
                entry("shell.example.edu", &old),
            ],
        );

        assert_eq!(
            verdict(
                std::slice::from_ref(&file),
                "shell.example.edu",
                22,
                &ed25519()
            ),
            Verdict::Changed {
                path: file,
                line: 3,
                recorded: old
            }
        );
    }

    #[test]
    fn a_host_with_only_other_algorithms_on_record_is_unknown_but_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("shell.example.edu", &p256())],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 22, &ed25519()),
            Verdict::Unknown {
                other_types_known: true
            }
        );
    }

    #[test]
    fn a_revoked_key_is_revoked_even_where_a_plain_line_trusts_it() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let plain_first = write(
            dir.path(),
            "plain_first",
            &[
                entry("shell.example.edu", &key),
                entry("@revoked shell.example.edu", &key),
            ],
        );
        let revoked_first = write(
            dir.path(),
            "revoked_first",
            &[
                entry("@revoked shell.example.edu", &key),
                entry("shell.example.edu", &key),
            ],
        );

        for file in [plain_first, revoked_first] {
            assert_eq!(
                verdict(&[file], "shell.example.edu", 22, &key),
                Verdict::Revoked
            );
        }
    }

    #[test]
    fn a_revoked_line_for_another_key_neither_trusts_nor_changes() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let revoked_only = write(
            dir.path(),
            "revoked_only",
            &[entry("@revoked shell.example.edu", &ed25519())],
        );
        let with_plain = write(
            dir.path(),
            "with_plain",
            &[
                entry("@revoked shell.example.edu", &ed25519()),
                entry("shell.example.edu", &key),
            ],
        );

        assert_eq!(
            verdict(&[revoked_only], "shell.example.edu", 22, &key),
            Verdict::Unknown {
                other_types_known: false
            }
        );
        assert_eq!(
            verdict(&[with_plain], "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
    }

    /// A CA key signs host certificates; taking it as the host's own key
    /// would trust a host the CA never vouched for.
    #[test]
    fn a_cert_authority_line_never_vouches_for_a_host_key() {
        let dir = tempfile::tempdir().unwrap();
        let ca = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("@cert-authority shell.example.edu", &ca),
                entry("@cert-authority shell.example.edu", &p256()),
            ],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 22, &ca),
            Verdict::Unknown {
                other_types_known: false
            }
        );
    }

    #[test]
    fn a_line_with_an_unknown_marker_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let key = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("@future-marker shell.example.edu", &key)],
        );

        assert_eq!(
            verdict(&[file], "shell.example.edu", 22, &key),
            Verdict::Unknown {
                other_types_known: false
            }
        );
    }

    #[test]
    fn recorded_algorithms_lists_the_hosts_plain_keys_in_file_order_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("shell.example.edu", &ed25519()),
                entry("other.example.edu", &p384()),
                entry("@revoked shell.example.edu", &p384()),
                entry("@cert-authority shell.example.edu", &p384()),
                entry("shell.example.edu", &p256()),
                entry("shell.example.edu", &ed25519()),
            ],
        );

        assert_eq!(
            recorded_algorithms(&[file], "shell.example.edu", 22),
            [
                Algorithm::Ed25519,
                Algorithm::Ecdsa {
                    curve: EcdsaCurve::NistP256
                },
            ]
        );
    }

    /// OpenSSH has refused `ssh-rsa`'s SHA-1 signatures by default since 8.8,
    /// so a recorded RSA key asks for its SHA-2 signatures.
    #[test]
    fn recorded_algorithms_offers_an_rsa_key_under_sha2_signatures_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("shell.example.edu", &p256()),
                format!("shell.example.edu {RSA}"),
            ],
        );

        assert_eq!(
            recorded_algorithms(&[file], "shell.example.edu", 22),
            [
                Algorithm::Ecdsa {
                    curve: EcdsaCurve::NistP256
                },
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha512)
                },
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha256)
                },
            ]
        );
    }

    /// What OpenSSH's own lookup finds for `name` in `file`: the lines
    /// `ssh-keygen -F` prints, or `None` when there's no `ssh-keygen` here.
    fn openssh_finds(file: &Path, name: &str) -> Option<Vec<String>> {
        let out = std::process::Command::new("ssh-keygen")
            .arg("-F")
            .arg(name)
            .arg("-f")
            .arg(file)
            .output();
        let out = match out {
            Ok(out) => out,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipped OpenSSH's check: no ssh-keygen");
                return None;
            }
            Err(e) => panic!("ssh-keygen: {e}"),
        };
        let text = String::from_utf8_lossy(&out.stdout);
        Some(
            text.lines()
                .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }

    #[test]
    fn trusting_a_key_records_it_where_openssh_finds_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".ssh").join("known_hosts");
        let key = ed25519();
        let other_port = p256();

        trust(&file, "Shell.Example.edu", 22, &key, false).unwrap();
        trust(&file, "shell.example.edu", 2222, &other_port, false).unwrap();

        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            format!(
                "{}\n{}\n",
                entry("shell.example.edu", &key),
                entry("[shell.example.edu]:2222", &other_port)
            )
        );
        let files = [file.clone()];
        assert_eq!(
            verdict(&files, "shell.example.edu", 22, &key),
            Verdict::Trusted
        );
        assert_eq!(
            verdict(&files, "shell.example.edu", 2222, &other_port),
            Verdict::Trusted
        );
        if let Some(found) = openssh_finds(&file, "shell.example.edu") {
            assert_eq!(found, [entry("shell.example.edu", &key)]);
            let found = openssh_finds(&file, "[shell.example.edu]:2222").unwrap();
            assert_eq!(found, [entry("[shell.example.edu]:2222", &other_port)]);
        }
    }

    #[test]
    fn a_hashed_trust_hides_the_name_from_all_but_a_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("known_hosts");
        let key = ed25519();

        trust(&file, "shell.example.edu", 2222, &key, true).unwrap();

        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("|1|"), "{text}");
        assert!(!text.contains("example"), "{text}");
        assert_eq!(
            verdict(std::slice::from_ref(&file), "shell.example.edu", 2222, &key),
            Verdict::Trusted
        );
        if let Some(found) = openssh_finds(&file, "[shell.example.edu]:2222") {
            assert_eq!(found.len(), 1, "{found:?}");
        }
    }

    #[test]
    fn trusting_after_a_last_line_without_its_newline_starts_a_new_line() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("known_hosts");
        let old = entry("login.example.edu", &ed25519());
        std::fs::write(&file, &old).unwrap();
        let key = ed25519();

        trust(&file, "shell.example.edu", 22, &key, false).unwrap();

        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            format!("{old}\n{}\n", entry("shell.example.edu", &key))
        );
    }

    /// A line for `host` hashed as `ssh-keygen -H` writes it, with `key`.
    fn hashed_entry(host: &str, key: &PublicKey) -> String {
        entry(&hashed(host), key)
    }

    #[test]
    fn forgetting_removes_only_the_line_on_record_and_keeps_every_other_byte() {
        let dir = tempfile::tempdir().unwrap();
        let old = ed25519();
        let other = p256();
        let lines = [
            "# kept as written\t".to_owned(),
            hashed_entry("other.example.edu", &ed25519()),
            entry("@revoked shell.example.edu", &ed25519()),
            entry("@cert-authority *.example.edu", &ed25519()),
            entry("shell.example.edu", &old),
            entry("shell.example.edu", &other),
            "not a key line".to_owned(),
        ];
        let file = write(dir.path(), "known_hosts", &lines);
        let before = std::fs::read_to_string(&file).unwrap();

        assert_eq!(
            forget(&file, 5, "shell.example.edu", 22, &old).unwrap(),
            Some(5)
        );

        let after = std::fs::read_to_string(&file).unwrap();
        let removed = format!("{}\n", lines[4]);
        assert_eq!(after, before.replacen(&removed, "", 1));
        let new = ed25519();
        assert_eq!(
            verdict(std::slice::from_ref(&file), "shell.example.edu", 22, &new),
            Verdict::Unknown {
                other_types_known: true
            }
        );
    }

    #[test]
    fn forgetting_finds_the_line_when_the_file_moved_it_and_does_nothing_once_its_gone() {
        let dir = tempfile::tempdir().unwrap();
        let old = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("login.example.edu", &ed25519()),
                hashed_entry("[shell.example.edu]:2222", &old),
            ],
        );

        // The prompt named line 1, but the file has changed since.
        assert_eq!(
            forget(&file, 1, "shell.example.edu", 2222, &old).unwrap(),
            Some(2)
        );
        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after.lines().count(), 1);
        assert_eq!(
            forget(&file, 2, "shell.example.edu", 2222, &old).unwrap(),
            None
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), after);
    }

    #[test]
    fn forgetting_then_trusting_a_new_key_leaves_a_file_openssh_trusts() {
        let dir = tempfile::tempdir().unwrap();
        let old = ed25519();
        let new = ed25519();
        let file = write(
            dir.path(),
            "known_hosts",
            &[entry("[127.0.0.1]:2222", &old)],
        );

        forget(&file, 1, "127.0.0.1", 2222, &old).unwrap();
        trust(&file, "127.0.0.1", 2222, &new, false).unwrap();

        assert_eq!(
            verdict(std::slice::from_ref(&file), "127.0.0.1", 2222, &new),
            Verdict::Trusted
        );
        if let Some(found) = openssh_finds(&file, "[127.0.0.1]:2222") {
            assert_eq!(found, [entry("[127.0.0.1]:2222", &new)]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn forgetting_keeps_a_linked_file_linked_and_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let old = ed25519();
        let real = write(
            dir.path(),
            "dotfiles_known_hosts",
            &[
                entry("shell.example.edu", &old),
                entry("login.example.edu", &old),
            ],
        );
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("known_hosts");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        forget(&link, 1, "shell.example.edu", 22, &old).unwrap();

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            format!("{}\n", entry("login.example.edu", &old))
        );
        let mode = std::fs::metadata(&real).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn fingerprints_and_type_names_read_as_ssh_shows_them() {
        let key = PublicKey::from_openssh(RSA).unwrap();
        assert_eq!(algorithm_name(&key), "RSA");
        assert_eq!(algorithm_name(&ed25519()), "ED25519");
        assert_eq!(algorithm_name(&p256()), "ECDSA");
        let shown = fingerprint(&key);
        assert!(shown.starts_with("SHA256:"), "{shown}");
        assert!(!shown.ends_with('='), "{shown}");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("rsa.pub");
        std::fs::write(&file, format!("{RSA}\n")).unwrap();
        if let Ok(out) = std::process::Command::new("ssh-keygen")
            .args(["-l", "-E", "sha256", "-f"])
            .arg(&file)
            .output()
        {
            let said = String::from_utf8_lossy(&out.stdout);
            assert!(said.contains(&shown) && said.contains("(RSA)"), "{said}");
        }
    }

    #[test]
    fn a_key_of_another_type_on_record_names_its_line() {
        let dir = tempfile::tempdir().unwrap();
        let ecdsa = p256();
        let file = write(
            dir.path(),
            "known_hosts",
            &[
                entry("other.example.edu", &p384()),
                entry("@revoked shell.example.edu", &p384()),
                entry("shell.example.edu", &ecdsa),
            ],
        );
        let files = [file.clone()];
        let presented = ed25519();

        assert_eq!(
            other_type_on_record(&files, "shell.example.edu", 22, &presented),
            Some((file, 3, ecdsa.clone()))
        );
        assert_eq!(
            other_type_on_record(&files, "shell.example.edu", 22, &ecdsa),
            None
        );
        assert_eq!(
            other_type_on_record(&files, "login.example.edu", 22, &presented),
            None
        );
    }

    #[test]
    fn a_file_that_hashes_names_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let plain = write(
            dir.path(),
            "plain",
            &[entry("shell.example.edu", &ed25519())],
        );
        let hashed = write(
            dir.path(),
            "hashed",
            &[
                entry("shell.example.edu", &ed25519()),
                hashed_entry("login.example.edu", &ed25519()),
            ],
        );

        assert!(!has_hashed_names(&plain));
        assert!(has_hashed_names(&hashed));
        assert!(!has_hashed_names(&dir.path().join("missing")));
    }
}
