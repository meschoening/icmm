//! ICMM's key (ADR-0012): `~/.ssh/icmm_ed25519`, one per computer, made the
//! first time a platform accepts none of the user's keys, and added to each
//! platform that needs it with the user's password, once. It's an OpenSSH
//! Ed25519 key without a passphrase, so only the user can read it: 0600 on
//! macOS and Linux, and on Windows the home folder's own access list, which
//! OpenSSH accepts. Its public half sits beside it, as `ssh-keygen` leaves it.

use std::io::Write;
use std::path::{Path, PathBuf};

use russh::keys::ssh_key::{LineEnding, PrivateKey, PublicKey};
use russh::keys::{Algorithm, HashAlg};

pub const NAME: &str = "icmm_ed25519";

/// Where ICMM's key lives: `~/.ssh/icmm_ed25519`.
pub fn default_file() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join(NAME))
}

/// The key's public half, when `file` holds a key.
pub fn read(file: &Path) -> Option<PublicKey> {
    let key = PrivateKey::read_openssh_file(file).ok()?;
    Some(key.public_key().clone())
}

/// The key in `file`, made there when it's missing: answers its public half.
/// A file there that isn't a key is left alone, and is an error.
pub fn ensure(file: &Path) -> std::io::Result<PublicKey> {
    if file.exists() {
        return read(file).ok_or_else(|| {
            std::io::Error::other(format!(
                "{} is there, but it isn’t a key ICMM can read",
                file.display()
            ))
        });
    }
    let dir = file.parent().unwrap_or(Path::new("."));
    make_folder(dir)?;
    let mut key =
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(std::io::Error::other)?;
    key.set_comment(comment());
    let text = key
        .to_openssh(LineEnding::LF)
        .map_err(std::io::Error::other)?;
    match write_new(file, text.as_bytes()) {
        Ok(()) => {}
        // Another copy of ICMM made it meanwhile: it's the computer's key.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return read(file).ok_or(e);
        }
        Err(e) => return Err(e),
    }
    let public = key.public_key().clone();
    let mut pub_file = file.as_os_str().to_owned();
    pub_file.push(".pub");
    std::fs::write(&pub_file, format!("{}\n", public_line(&public)))?;
    set_mode(Path::new(&pub_file), 0o644)?;
    tracing::info!(
        "made ICMM's key {} ({})",
        file.display(),
        public.fingerprint(HashAlg::Sha256)
    );
    Ok(public)
}

/// The key as a line of `authorized_keys`: its type, its key and its comment.
pub fn public_line(key: &PublicKey) -> String {
    key.to_openssh().unwrap_or_default()
}

/// `~/.ssh`, made readable by the user only when it's missing; one that's
/// there keeps its permissions.
fn make_folder(dir: &Path) -> std::io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    return std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700)
        .create(dir);
    #[cfg(not(unix))]
    std::fs::create_dir(dir)
}

/// Writes `bytes` to `file` only if nothing is there, whole or not at all:
/// a key cut off halfway would stop every sign-in that names it.
fn write_new(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = file.parent().unwrap_or(Path::new("."));
    let temp = dir.join(format!(".{NAME}.{:016x}.tmp", fastrand::u64(..)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = (|| {
        let mut out = options.open(&temp)?;
        set_mode(&temp, 0o600)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        // A key made meanwhile by another copy of ICMM stays.
        std::fs::hard_link(&temp, file)
    })();
    let _ = std::fs::remove_file(&temp);
    written
}

/// Windows names the computer in its environment, so no console flashes up.
#[cfg(windows)]
fn computer_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

#[cfg(not(windows))]
fn computer_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn set_mode(file: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (file, mode);
        Ok(())
    }
}

/// `icmm@<this computer's name>`, which names the key in the platform's
/// `authorized_keys`.
fn comment() -> String {
    let name = computer_name().trim().to_lowercase();
    let name: String = name
        .split('.')
        .next()
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if name.is_empty() {
        "icmm".into()
    } else {
        format!("icmm@{name}")
    }
}
