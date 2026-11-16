//! `platforms.json` in the app's config folder: each saved platform's
//! Connection details, This computer's Data folder, which platform is active,
//! and which one ICMM connects to when it opens.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::connection::platform::{Jump, OLD_FILE, Platform};
use crate::wire::types::{
    InternalData, InvalidData, Issue, JumpHost, NotFoundData, PlatformForm, PlatformsProblem,
    SavedPlatform, SavedPlatforms, Severity, WireError,
};

pub const FILE: &str = "platforms.json";
pub const THIS_COMPUTER: &str = "this-computer";
const THIS_COMPUTER_NAME: &str = "This computer";
const DATA_FOLDER: &str = "~/icmm";

/// What launch does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// No platform is active yet, and none is chosen: First launch.
    Nothing,
    /// Connect to the launch choice, which becomes the Active platform.
    Connect(String),
    /// Don't connect: the Active platform shows, not connected.
    NotConnected(String),
}

/// Which platform ICMM connects to when it opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum LaunchChoice {
    Connect(String),
    DontConnect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    active: Option<String>,
    /// Unset until the first connect, which sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch: Option<LaunchChoice>,
    /// Files from before the launch choice: whether the user disconnected the
    /// Active platform. Read once into `launch`, never written.
    #[serde(default, skip_serializing)]
    disconnected: Option<bool>,
    this_computer: LocalRecord,
    platforms: Vec<SshRecord>,
}

impl File {
    /// Carries a file from before the launch choice over: an Active platform
    /// the user hadn't disconnected is the choice, and one they had is Don't
    /// connect, so launch does what it did before.
    fn carried_over(mut self) -> File {
        if let Some(disconnected) = self.disconnected.take()
            && self.launch.is_none()
        {
            self.launch = self.active.clone().map(|id| match disconnected {
                false => LaunchChoice::Connect(id),
                true => LaunchChoice::DontConnect,
            });
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalRecord {
    data_folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SshRecord {
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    data_folder: String,
    /// The hosts to go through first; files from before jump hosts have none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    jump: Vec<Jump>,
    /// Whether it connected from this computer, at this host and account:
    /// then a refused key is a failure, not a first connect's question.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    connected: bool,
}

impl Default for File {
    fn default() -> File {
        File {
            active: None,
            launch: None,
            disconnected: None,
            this_computer: LocalRecord {
                data_folder: DATA_FOLDER.into(),
            },
            platforms: Vec::new(),
        }
    }
}

/// The saved platforms, and where they're kept.
pub struct Saved {
    path: PathBuf,
    file: File,
    /// Why the saved platforms couldn't be read.
    problem: Option<PlatformsProblem>,
    /// Whether `path` holds a file that couldn't be read, to move aside
    /// before the first save.
    unreadable: bool,
}

impl Saved {
    /// The saved platforms in `dir`, carrying over `active-platform.json` the
    /// first time. Never fails: a file that can't be read leaves This computer,
    /// and says why.
    pub fn load(dir: &Path) -> Saved {
        let path = dir.join(FILE);
        let mut saved = Saved {
            path: path.clone(),
            file: File::default(),
            problem: None,
            unreadable: false,
        };
        match saved.lock() {
            Ok(_lock) => saved.reload(dir),
            Err(error) => {
                let lock = saved.path.with_file_name("platforms.lock");
                saved.problem = Some(problem(
                    "ICMM couldn’t open the platforms you saved on this computer.",
                    format!("{} · {error}", tilde(&lock)),
                    false,
                ));
            }
        }
        saved
    }

    /// The separate lock file is never renamed or removed: all processes must
    /// lock the same inode, including during migration and broken-file recovery.
    fn lock(&self) -> std::io::Result<std::fs::File> {
        let dir = self.path.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(dir)?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("platforms.lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    /// Called only while holding the lock. Refresh before validation as well as
    /// writing, so a stale process cannot lose additions or resurrect removals.
    fn reload(&mut self, dir: &Path) {
        self.file = File::default();
        self.problem = None;
        self.unreadable = false;
        let read = std::fs::read_to_string(&self.path);
        match read.map(|text| without_python(&text)) {
            Ok(Ok(file)) => self.file = File::carried_over(file),
            // Where the text broke, as #117's note draws it; a file that parses but
            // isn't platforms has no place to point to, so it says what's wrong.
            Ok(Err(e)) if e.line() > 0 => {
                self.unreadable(&format!("line {} column {}", e.line(), e.column()))
            }
            Ok(Err(e)) => self.unreadable(&e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.carry_over(dir),
            Err(e) => self.unreadable(&e.to_string()),
        }
    }

    /// Dropping the returned handle releases the OS lock, including on errors
    /// and process exit. Keep it alive through the entire read/modify/write.
    fn begin_write(&mut self) -> Result<std::fs::File, WireError> {
        let lock = self
            .lock()
            .map_err(|e| self.internal(&format!("Couldn’t lock the saved platforms: {e}.")))?;
        let dir = self.path.parent().unwrap_or(Path::new(".")).to_owned();
        self.reload(&dir);
        Ok(lock)
    }

    fn unreadable(&mut self, why: &str) {
        self.problem = Some(problem(
            "ICMM couldn’t read the platforms you saved on this computer.",
            format!("{} · {why}", tilde(&self.path)),
            true,
        ));
        self.unreadable = true;
    }

    /// Makes the old hand-written platform the Active one, and saves it.
    fn carry_over(&mut self, dir: &Path) {
        let path = dir.join(OLD_FILE);
        let old = match std::fs::read_to_string(&path) {
            Ok(text) => without_python::<Platform>(&text).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => Err(e.to_string()),
        };
        let old = match old {
            Ok(old) => old,
            Err(why) => {
                self.problem = Some(problem(
                    "ICMM couldn’t read the platform an earlier version of ICMM saved on this computer.",
                    format!("{} · {why}", tilde(&path)),
                    false,
                ));
                return;
            }
        };
        let mut file = File::default();
        let name = old.name();
        match old {
            Platform::Local { data_folder, .. } => {
                file.this_computer = LocalRecord { data_folder };
                file.active = Some(THIS_COMPUTER.into());
                file.launch = Some(LaunchChoice::Connect(THIS_COMPUTER.into()));
            }
            Platform::Ssh {
                host,
                port,
                user,
                identity_file,
                data_folder,
                jump,
                ..
            } => {
                let id = new_id();
                file.platforms.push(SshRecord {
                    id: id.clone(),
                    name,
                    host,
                    port: port.unwrap_or(22),
                    user,
                    identity_file,
                    data_folder,
                    jump,
                    connected: false,
                });
                file.active = Some(id.clone());
                file.launch = Some(LaunchChoice::Connect(id));
            }
        }
        tracing::info!(
            "carried {} over into {}",
            path.display(),
            self.path.display()
        );
        // Kept in memory when it can't be saved, and the next save tries again.
        if let Err(error) = self.save(file.clone()) {
            self.file = file;
            self.problem = Some(problem(
                "ICMM couldn’t save your platforms on this computer.",
                match error {
                    WireError::Internal { message, .. } => message,
                    other => format!("{other:?}"),
                },
                false,
            ));
        }
    }

    /// How to reach a saved platform.
    pub fn target(&self, id: &str) -> Option<Platform> {
        if id == THIS_COMPUTER {
            let LocalRecord { data_folder } = self.file.this_computer.clone();
            return Some(Platform::Local {
                name: Some(THIS_COMPUTER_NAME.into()),
                data_folder,
            });
        }
        let p = self.file.platforms.iter().find(|p| p.id == id)?.clone();
        Some(Platform::Ssh {
            name: Some(p.name),
            host: p.host,
            port: Some(p.port),
            user: p.user,
            identity_file: p.identity_file,
            data_folder: p.data_folder,
            jump: p.jump,
        })
    }

    /// A saved platform's name.
    pub fn name(&self, id: &str) -> Option<String> {
        self.target(id).map(|t| t.name())
    }

    /// Checks an SSH platform's form and saves it as the newest; answers its id.
    pub fn add(&mut self, form: PlatformForm) -> Result<String, WireError> {
        let _lock = self.begin_write()?;
        let PlatformForm::Ssh {
            name,
            host,
            port,
            user,
            identity_file,
            data_folder,
            jump,
        } = form
        else {
            return Err(invalid(vec![issue(
                &["form", "type"],
                "This computer is built in, so it can’t be added.",
            )]));
        };
        let checked = check_ssh(
            &self.file,
            None,
            SshFields {
                name,
                host,
                port,
                user,
                identity_file,
                data_folder,
                jump,
            },
        )?;
        let id = new_id();
        let mut file = self.file.clone();
        file.platforms.insert(0, checked.into_record(id.clone()));
        self.save(file)?;
        Ok(id)
    }

    /// Checks and saves a platform's form; answers whether it changed how the
    /// platform is reached (anything but its name).
    pub fn edit(&mut self, id: &str, form: PlatformForm) -> Result<bool, WireError> {
        let _lock = self.begin_write()?;
        let mut file = self.file.clone();
        let changed = if id == THIS_COMPUTER {
            let PlatformForm::Local { data_folder } = form else {
                return Err(invalid(vec![issue(
                    &["form", "type"],
                    "This computer is built in: only its Data folder can change.",
                )]));
            };
            let data_folder = data_folder.trim().to_owned();
            if let Some(message) = local_folder_problem(&data_folder) {
                return Err(invalid(vec![issue(&["form", "data_folder"], message)]));
            }
            let changed = file.this_computer.data_folder != data_folder;
            file.this_computer.data_folder = data_folder;
            changed
        } else {
            let index = self.index(id)?;
            let PlatformForm::Ssh {
                name,
                host,
                port,
                user,
                identity_file,
                data_folder,
                jump,
            } = form
            else {
                return Err(invalid(vec![issue(
                    &["form", "type"],
                    &format!(
                        "{} is reached over SSH, so it takes an SSH form.",
                        file.platforms[index].name
                    ),
                )]));
            };
            let fields = SshFields {
                name,
                host,
                port,
                user,
                identity_file,
                data_folder,
                jump,
            };
            let old = &mut file.platforms[index];
            let mut record = check_ssh(&self.file, Some(id), fields)?.into_record(id.to_owned());
            // Another host or account hasn't been connected to.
            record.connected = old.connected
                && (&record.host, record.port, &record.user) == (&old.host, old.port, &old.user);
            let changed = SshRecord {
                name: old.name.clone(),
                ..record.clone()
            } != *old;
            *old = record;
            changed
        };
        self.save(file)?;
        Ok(changed)
    }

    /// Saves `key` as the key to sign in to host `hop` on the way to platform
    /// `id` with: a jump host, or the login host after them.
    pub fn use_key(&mut self, id: &str, hop: usize, key: &str) -> Result<(), WireError> {
        let _lock = self.begin_write()?;
        let index = self.index(id)?;
        let key = key.trim().to_owned();
        if key.is_empty() || !expand_home(&key).is_file() {
            return Err(invalid(vec![issue(
                &["identity_file"],
                &format!("There’s no file at {key}."),
            )]));
        }
        let mut file = self.file.clone();
        let record = &mut file.platforms[index];
        let hops = record.jump.len();
        match record.jump.get_mut(hop) {
            Some(jump) => jump.identity_file = Some(key),
            None if hop == hops => record.identity_file = Some(key),
            None => {
                return Err(invalid(vec![issue(
                    &["hop"],
                    &format!("{} has no host {hop} on the way.", record.name),
                )]));
            }
        }
        self.save(file)
    }

    /// Records that platform `id` connected from this computer, only if its
    /// saved host, port and account still match the endpoint that connected.
    pub fn connected(&mut self, id: &str, endpoint: &Platform) -> Result<(), WireError> {
        let Platform::Ssh {
            host, port, user, ..
        } = endpoint
        else {
            return Ok(());
        };
        let _lock = self.begin_write()?;
        let index = self.index(id)?;
        let record = &self.file.platforms[index];
        if record.connected
            || (&record.host, record.port, &record.user) != (host, port.unwrap_or(22), user)
        {
            return Ok(());
        }
        let mut file = self.file.clone();
        file.platforms[index].connected = true;
        self.save(file)
    }

    /// Whether platform `id` connected from this computer before.
    pub fn connected_before(&self, id: &str) -> bool {
        self.file
            .platforms
            .iter()
            .any(|p| p.id == id && p.connected)
    }

    /// Forgets a saved platform; the Active platform leaves no Active
    /// platform, and the launch choice leaves Don't connect.
    pub fn remove(&mut self, id: &str) -> Result<(), WireError> {
        let _lock = self.begin_write()?;
        if id == THIS_COMPUTER {
            return Err(invalid(vec![issue(
                &["id"],
                "This computer is built in, so it can’t be removed.",
            )]));
        }
        let index = self.index(id)?;
        let mut file = self.file.clone();
        file.platforms.remove(index);
        if file.active.as_deref() == Some(id) {
            file.active = None;
        }
        if file.launch == Some(LaunchChoice::Connect(id.to_owned())) {
            file.launch = Some(LaunchChoice::DontConnect);
        }
        self.save(file)
    }

    /// Forgets every saved platform, as if ICMM were just installed: deletes
    /// the file, any unreadable one moved aside, and the hand-written
    /// `active-platform.json` a first launch would carry over again. The lock
    /// file stays, since every process locks that same file.
    pub fn forget_all(&mut self) -> std::io::Result<()> {
        let _lock = self.lock()?;
        let dir = self.path.parent().unwrap_or(Path::new(".")).to_owned();
        // The file goes last: while it's there, a reload never carries the
        // old one over, so a delete that fails leaves the platforms as they were.
        let mut doomed = vec![dir.join(OLD_FILE)];
        for entry in std::fs::read_dir(&dir)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("platforms.broken") && name.ends_with(".json") {
                doomed.push(entry.path());
            }
        }
        doomed.push(self.path.clone());
        let deleted = doomed
            .iter()
            .try_for_each(|path| match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(std::io::Error::new(
                    e.kind(),
                    format!("{}: {e}", path.display()),
                )),
                _ => Ok(()),
            });
        self.reload(&dir);
        deleted
    }

    /// Makes `id` the Active platform, to connect to now; the first connect
    /// also makes it the launch choice.
    pub fn activate(&mut self, id: &str) -> Result<(), WireError> {
        let _lock = self.begin_write()?;
        self.known(id)?;
        let mut file = self.file.clone();
        file.active = Some(id.to_owned());
        if file.launch.is_none() {
            file.launch = Some(LaunchChoice::Connect(id.to_owned()));
        }
        if file == self.file {
            return Ok(());
        }
        self.save(file)
    }

    /// Sets the platform to connect to when ICMM opens; `None` is Don't connect.
    pub fn set_launch(&mut self, id: Option<&str>) -> Result<(), WireError> {
        let _lock = self.begin_write()?;
        let launch = match id {
            Some(id) => {
                self.known(id)?;
                LaunchChoice::Connect(id.to_owned())
            }
            None => LaunchChoice::DontConnect,
        };
        let mut file = self.file.clone();
        file.launch = Some(launch);
        if file == self.file {
            return Ok(());
        }
        self.save(file)
    }

    /// Checks that `id` is a saved platform, This computer included.
    fn known(&self, id: &str) -> Result<(), WireError> {
        if id != THIS_COMPUTER {
            self.index(id)?;
        }
        Ok(())
    }

    fn index(&self, id: &str) -> Result<usize, WireError> {
        self.file
            .platforms
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| WireError::NotFound {
                message: format!("There’s no saved platform {id}."),
                data: NotFoundData {
                    kind: "platform".into(),
                    id: id.to_owned(),
                },
            })
    }

    // All callers hold the interprocess lock through replacement of the file.
    fn save(&mut self, file: File) -> Result<(), WireError> {
        if self.unreadable {
            self.move_aside().map_err(|e| {
                self.internal(&format!(
                    "Couldn’t move the unreadable {} aside: {e}.",
                    self.path.display()
                ))
            })?;
        }
        write_atomically(&self.path, &file).map_err(|e| {
            self.internal(&format!(
                "Couldn’t save the platforms to {}: {e}.",
                self.path.display()
            ))
        })?;
        self.file = file;
        self.problem = None;
        Ok(())
    }

    /// Renames the unreadable file to the first free `platforms.broken*.json`.
    fn move_aside(&mut self) -> std::io::Result<()> {
        let dir = self.path.parent().unwrap_or(Path::new("."));
        let aside = (1..)
            .map(|n| match n {
                1 => dir.join("platforms.broken.json"),
                n => dir.join(format!("platforms.broken-{n}.json")),
            })
            .find(|p| !p.exists())
            .expect("a free name");
        std::fs::rename(&self.path, &aside)?;
        tracing::warn!("moved the unreadable platforms file to {}", aside.display());
        self.unreadable = false;
        Ok(())
    }

    fn internal(&self, message: &str) -> WireError {
        tracing::error!("{message}");
        WireError::Internal {
            message: message.to_owned(),
            data: InternalData {
                log_ref: "app.log".into(),
            },
        }
    }

    pub fn view(&self) -> SavedPlatforms {
        let mut platforms: Vec<SavedPlatform> = self
            .file
            .platforms
            .iter()
            .map(|p| SavedPlatform::Ssh {
                id: p.id.clone(),
                name: p.name.clone(),
                host: p.host.clone(),
                port: std::num::NonZeroU64::new(p.port.into()).unwrap_or(std::num::NonZeroU64::MIN),
                user: p.user.clone(),
                identity_file: p.identity_file.clone(),
                data_folder: p.data_folder.clone(),
                jump: p
                    .jump
                    .iter()
                    .map(|j| JumpHost {
                        host: j.host.clone(),
                        port: std::num::NonZeroU64::new(j.port.into())
                            .unwrap_or(std::num::NonZeroU64::MIN),
                        user: j.user.clone(),
                        identity_file: j.identity_file.clone(),
                    })
                    .collect(),
            })
            .collect();
        platforms.push(SavedPlatform::Local {
            id: THIS_COMPUTER.into(),
            name: THIS_COMPUTER_NAME.into(),
            data_folder: self.file.this_computer.data_folder.clone(),
        });
        SavedPlatforms {
            platforms,
            active: self.file.active.clone(),
            launch: match &self.file.launch {
                Some(LaunchChoice::Connect(id)) => Some(id.clone()),
                Some(LaunchChoice::DontConnect) | None => None,
            },
            launch_set: self.file.launch.is_some(),
            problem: self.problem.clone(),
        }
    }

    pub fn launch(&self) -> Launch {
        match (&self.file.launch, &self.file.active) {
            (Some(LaunchChoice::Connect(id)), _) => Launch::Connect(id.clone()),
            (_, Some(id)) => Launch::NotConnected(id.clone()),
            (_, None) => Launch::Nothing,
        }
    }
}

/// An SSH form's fields, before they're checked.
struct SshFields {
    name: String,
    host: String,
    port: String,
    user: String,
    identity_file: Option<String>,
    data_folder: String,
    jump: Vec<JumpHost>,
}

/// An SSH form's fields, checked and trimmed.
struct Checked {
    name: String,
    host: String,
    port: u16,
    user: String,
    identity_file: Option<String>,
    data_folder: String,
    jump: Vec<Jump>,
}

impl Checked {
    fn into_record(self, id: String) -> SshRecord {
        SshRecord {
            id,
            name: self.name,
            host: self.host,
            port: self.port,
            user: self.user,
            identity_file: self.identity_file,
            data_folder: self.data_folder,
            jump: self.jump,
            connected: false,
        }
    }
}

/// Checks every field, and answers every issue at once. `editing` is the
/// platform being edited, whose own name doesn't count as taken.
fn check_ssh(file: &File, editing: Option<&str>, f: SshFields) -> Result<Checked, WireError> {
    let mut issues = Vec::new();
    let name = f.name.trim().to_owned();
    if name.is_empty() {
        issues.push(issue(&["form", "name"], "Give it a name."));
    } else if let Some(taken) = taken_name(file, editing, &name) {
        issues.push(issue(
            &["form", "name"],
            &format!("Another platform is called {taken}."),
        ));
    }
    let host = f.host.trim().to_owned();
    if host.is_empty() {
        issues.push(issue(&["form", "host"], "Enter the login host."));
    } else if host.contains('@') {
        issues.push(issue(
            &["form", "host"],
            "Put the username in Username, and only the host here.",
        ));
    } else if host.chars().any(char::is_whitespace) {
        issues.push(issue(&["form", "host"], "A host name has no spaces."));
    } else if host.starts_with('-') {
        issues.push(issue(&["form", "host"], "A host name can’t start with -."));
    }
    let port = match f.port.trim().parse::<u16>() {
        Ok(port) if port > 0 => port,
        _ => {
            issues.push(issue(
                &["form", "port"],
                "A port is a number from 1 to 65535.",
            ));
            0
        }
    };
    let user = f.user.trim().to_owned();
    if user.is_empty() {
        issues.push(issue(&["form", "user"], "Enter your username on the host."));
    } else if user.chars().any(char::is_whitespace) {
        issues.push(issue(&["form", "user"], "A username has no spaces."));
    }
    let identity_file = f
        .identity_file
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty());
    if let Some(key) = &identity_file
        && !expand_home(key).is_file()
    {
        issues.push(issue(
            &["form", "identity_file"],
            &format!("There’s no file at {key}."),
        ));
    }
    let data_folder = f.data_folder.trim().to_owned();
    if let Some(message) = remote_folder_problem(&data_folder) {
        issues.push(issue(&["form", "data_folder"], message));
    }
    let jump = check_jump(f.jump, &mut issues);
    if !issues.is_empty() {
        return Err(invalid(issues));
    }
    Ok(Checked {
        name,
        host,
        port,
        user,
        identity_file,
        data_folder,
        jump,
    })
}

/// Checks the jump hosts, which `~/.ssh/config` filled in: the form has no
/// fields for them, so their issues name the host.
fn check_jump(jump: Vec<JumpHost>, issues: &mut Vec<Issue>) -> Vec<Jump> {
    let mut checked = Vec::new();
    for (index, hop) in jump.into_iter().enumerate() {
        let index = index.to_string();
        let at = |field: &str| {
            vec![
                "form".to_owned(),
                "jump".into(),
                index.clone(),
                field.into(),
            ]
        };
        let host = hop.host.trim().to_owned();
        let user = hop.user.trim().to_owned();
        let bad = |s: &str| {
            s.is_empty() || s.starts_with('-') || s.contains(char::is_whitespace) || s.contains('@')
        };
        if bad(&host) {
            issues.push(Issue {
                path: at("host"),
                message: format!("The jump host “{host}” isn’t a host name."),
                severity: Severity::Error,
            });
        }
        if bad(&user) {
            issues.push(Issue {
                path: at("user"),
                message: format!("The username for {host} isn’t one."),
                severity: Severity::Error,
            });
        }
        let port = u16::try_from(hop.port.get()).unwrap_or(0);
        if port == 0 {
            issues.push(Issue {
                path: at("port"),
                message: format!("{host}’s port is a number from 1 to 65535."),
                severity: Severity::Error,
            });
        }
        let identity_file = hop
            .identity_file
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty());
        if let Some(key) = &identity_file
            && !expand_home(key).is_file()
        {
            issues.push(Issue {
                path: at("identity_file"),
                message: format!("There’s no file at {key}, the key for {host}."),
                severity: Severity::Error,
            });
        }
        checked.push(Jump {
            host,
            port,
            user,
            identity_file,
        });
    }
    checked
}

/// The name `name` collides with, ignoring case, if any.
fn taken_name(file: &File, editing: Option<&str>, name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    std::iter::once(THIS_COMPUTER_NAME)
        .chain(
            file.platforms
                .iter()
                .filter(|p| Some(p.id.as_str()) != editing)
                .map(|p| p.name.as_str()),
        )
        .find(|other| other.to_lowercase() == lower)
        .map(str::to_owned)
}

/// Why `folder` can't be This computer's Data folder.
fn local_folder_problem(folder: &str) -> Option<&'static str> {
    if folder.is_empty() {
        Some("Enter a folder, such as ~/icmm.")
    } else if !(folder.starts_with("~/") || Path::new(folder).is_absolute()) {
        Some("Use a full path, such as ~/icmm.")
    } else {
        None
    }
}

/// Why `folder` can't be a Data folder on an SSH host, whose paths are POSIX.
fn remote_folder_problem(folder: &str) -> Option<&'static str> {
    if folder.is_empty() {
        Some("Enter a folder, such as ~/icmm.")
    } else if !(folder.starts_with("~/") || folder.starts_with('/')) {
        Some("Start it with ~/ or /.")
    } else {
        None
    }
}

fn issue(path: &[&str], message: &str) -> Issue {
    Issue {
        path: path.iter().map(|p| (*p).to_owned()).collect(),
        message: message.to_owned(),
        severity: Severity::Error,
    }
}

fn invalid(issues: Vec<Issue>) -> WireError {
    WireError::Invalid {
        message: "Check the highlighted fields.".into(),
        data: InvalidData { issues },
    }
}

/// A new platform's id: random, and never "this-computer".
fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijkmnpqrstuvwxyz";
    let mut id = String::from("p");
    for _ in 0..9 {
        id.push(ALPHABET[fastrand::usize(..ALPHABET.len())] as char);
    }
    id
}

/// Why the saved platforms couldn't be read, logged as it's said: the
/// sentence, then the file and what went wrong (#117).
fn problem(reason: &str, details: String, moves_aside: bool) -> PlatformsProblem {
    tracing::error!("{reason} {details}");
    PlatformsProblem {
        reason: reason.into(),
        details,
        moves_aside,
    }
}

/// A local path with a leading `~/` in the home folder.
pub fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// A local path as the user reads it: in the home folder, from `~`.
pub fn tilde(path: &Path) -> String {
    let rest =
        std::env::home_dir().and_then(|home| path.strip_prefix(home).ok().map(Path::to_owned));
    match rest {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => {
            let parts: Vec<String> = rest
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            format!("~/{}", parts.join("/"))
        }
        None => path.display().to_string(),
    }
}

/// Writes `file` beside `path` and renames it into place, so a crash never
/// leaves half a file.
fn write_atomically(path: &Path, file: &File) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(file).map_err(std::io::Error::other)?;
    text.push('\n');
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

/// `text` parsed as `T`, without the `python` keys that platforms.json and
/// active-platform.json held, written by hand, until the engine installed
/// itself. The next save leaves them out.
fn without_python<T: serde::de::DeserializeOwned>(text: &str) -> serde_json::Result<T> {
    let mut value: serde_json::Value = serde_json::from_str(text)?;
    let drop_from = |v: &mut serde_json::Value| {
        if let Some(object) = v.as_object_mut() {
            object.remove("python");
        }
    };
    drop_from(&mut value);
    if let Some(local) = value.get_mut("this_computer") {
        drop_from(local);
    }
    if let Some(platforms) = value.get_mut("platforms").and_then(|p| p.as_array_mut()) {
        platforms.iter_mut().for_each(drop_from);
    }
    serde_json::from_value(value)
}
