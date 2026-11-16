//! How to reach a platform: what the platforms store hands the connection.
//! It still reads the old hand-written `active-platform.json`, which the
//! store carries over once.
//!
//! ```json
//! {"kind": "local", "data_folder": "~/icmm-data"}
//! {"kind": "ssh", "name": "McKelvey HPC", "host": "login.example.edu", "user": "me",
//!  "data_folder": "~/icmm-data"}
//! ```

use serde::{Deserialize, Serialize};

use super::known_hosts;
use super::local::Local;
use super::ssh::{Ssh, SshHop, SshTarget};
use super::transport::Transport;
use crate::engine::{CLUSTER_TARGET, Engine, Engines, host_target};
use crate::platforms::store::expand_home;

/// The file the Settings screens replaced, carried over once.
pub const OLD_FILE: &str = "active-platform.json";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Platform {
    Local {
        name: Option<String>,
        data_folder: String,
    },
    Ssh {
        name: Option<String>,
        host: String,
        port: Option<u16>,
        user: String,
        /// Tries the ssh-agent and the usual key files when absent.
        identity_file: Option<String>,
        /// On the host; `~/` is the remote home.
        data_folder: String,
        /// The hosts to go through first, in order (`ProxyJump`).
        #[serde(default)]
        jump: Vec<Jump>,
    },
}

/// A host a connect goes through first, as `~/.ssh/config` resolved it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Jump {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub identity_file: Option<String>,
}

impl Platform {
    pub fn name(&self) -> String {
        match self {
            Platform::Local { name, .. } => name.clone().unwrap_or_else(|| "This computer".into()),
            Platform::Ssh { name, host, .. } => name.clone().unwrap_or_else(|| host.clone()),
        }
    }

    /// How to reach it, with the engine from `engines` that it runs. The
    /// engine is looked up when the connect needs it, so making the
    /// transport reads no archive.
    pub fn transport(&self, engines: &Engines) -> Box<dyn Transport> {
        let target = match self {
            Platform::Local { .. } => host_target(),
            Platform::Ssh { .. } => CLUSTER_TARGET,
        };
        let engine = Engine::Find(engines.clone(), target);
        match self {
            Platform::Local { data_folder, .. } => {
                Box::new(Local::new(engine, expand_home(data_folder)))
            }
            Platform::Ssh {
                host,
                port,
                user,
                identity_file,
                data_folder,
                jump,
                ..
            } => Box::new(
                Ssh::new(
                    SshTarget {
                        host: host.clone(),
                        port: port.unwrap_or(22),
                        user: user.clone(),
                        identity_file: identity_file.as_deref().map(expand_home),
                        jump: jump
                            .iter()
                            .map(|j| SshHop {
                                host: j.host.clone(),
                                port: j.port,
                                user: j.user.clone(),
                                identity_file: j.identity_file.as_deref().map(expand_home),
                            })
                            .collect(),
                    },
                    known_hosts::default_files(),
                    engine,
                    data_folder,
                )
                .named(self.name()),
            ),
        }
    }
}
