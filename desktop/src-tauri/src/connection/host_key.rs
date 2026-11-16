//! A host key the known_hosts files don't vouch for, as a connect stops at
//! it (LaptopConnection's `host-unknown` and `host-changed`): what the card
//! shows, and what trusting the key or forgetting the old one changes.

use std::path::PathBuf;

use russh::keys::ssh_key::PublicKey;

use super::known_hosts;
use crate::platforms::ssh_config;
use crate::platforms::store::tilde;
use crate::wire::types::{HostKey, RecordedKey};

/// A host's key that known_hosts doesn't vouch for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyQuestion {
    pub host: String,
    pub port: u16,
    /// The key the host presented.
    pub key: PublicKey,
    /// The known_hosts file that trusting the key adds it to.
    pub file: PathBuf,
    /// Whether that line's name is hashed; `None` asks `ssh -G`
    /// (`HashKnownHosts`).
    pub hashed: Option<bool>,
    /// The host's other key of the same algorithm, when its key changed.
    pub recorded: Option<Recorded>,
}

/// The key known_hosts records for a host, and the line that records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub key: PublicKey,
    pub file: PathBuf,
    /// 1-based.
    pub line: usize,
}

impl HostKeyQuestion {
    /// The question as the app shows it.
    pub fn wire(&self) -> HostKey {
        HostKey {
            host: known_hosts::lookup_name(&self.host, self.port),
            algorithm: known_hosts::algorithm_name(&self.key),
            fingerprint: known_hosts::fingerprint(&self.key),
            recorded: self.recorded.as_ref().map(|r| RecordedKey {
                algorithm: known_hosts::algorithm_name(&r.key),
                fingerprint: known_hosts::fingerprint(&r.key),
                file: tilde(&r.file),
                line: std::num::NonZeroU64::new(r.line as u64).unwrap_or(std::num::NonZeroU64::MIN),
            }),
            forgot: false,
        }
    }

    /// Records the key as the host's, so the next connect trusts it: its
    /// name hashed when the file hashes names already, or `ssh -G` says to.
    pub async fn trust(&self) -> std::io::Result<()> {
        let hashed = match self.hashed {
            Some(hashed) => hashed,
            None if known_hosts::has_hashed_names(&self.file) => true,
            None => match ssh_config::Source::users() {
                Some(source) => source.hashes_known_hosts(&self.host, self.port).await,
                None => false,
            },
        };
        let Self {
            host,
            port,
            key,
            file,
            ..
        } = self.clone();
        tokio::task::spawn_blocking(move || known_hosts::trust(&file, &host, port, &key, hashed))
            .await
            .map_err(std::io::Error::other)?
    }

    /// Removes the line that records the host's old key; answers the line
    /// removed, or `None` when nothing records it any more.
    pub async fn forget(&self) -> std::io::Result<Option<usize>> {
        let Some(Recorded { key, file, line }) = self.recorded.clone() else {
            return Ok(None);
        };
        let (host, port) = (self.host.clone(), self.port);
        tokio::task::spawn_blocking(move || known_hosts::forget(&file, line, &host, port, &key))
            .await
            .map_err(std::io::Error::other)?
    }
}
