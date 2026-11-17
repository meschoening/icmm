//! The bodies of the desktop commands in the wire registry. `wire::commands`
//! wraps each as a Tauri command of the same name and type.

pub use crate::logging::log_frontend_event;
pub use crate::webview::webview_info;

use tauri::{Manager, Wry};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

use crate::active::platforms as saved;
use crate::dataset_file;
use crate::platforms::keys::private_keys;
use crate::platforms::ssh_config;
use crate::platforms::store::{expand_home, tilde};
use crate::run_logs;
use crate::wire::types::{
    AddPlatformParams, AddSshKeyParams, CanonicalParameters, CanonicalParametersParams,
    ChooseParams, Chosen, ConnectionState, DatasetContent, DatasetFile, EdgeRates, EdgeRatesParams,
    EditPlatformParams, EvaluationTime, ExportFileParams, ExportFolderParams, ExportFormat,
    ForgetHostKeyParams, GuardQuitParams, HomeFolder, InternalData, InvalidData, Issue,
    LaunchPlatformParams, LogsFolder, MarkRunsParams, MatchTopologyParams, NotificationParams,
    PlatformRef, Preferences, ProposeSplitParams, Protocol, ReadDatasetFileParams,
    ReadWorkbookParams, RecentlyOpened, RecentlyOpenedParams, RecordOpenedParams,
    RegenerateDatasetParams, ReportPreview, ResetParams, RevealLogParams, RevealParams, RunMarks,
    RunMarksParams, SaveReportParams, SavedPlatform, SavedPlatforms, SavedReport, Severity,
    SimulateStartParams, SshConfigHost, SshConfigHostParams, SshConfigHosts, SshKeys,
    StartSimulation, Theme, TimeEvaluationsParams, TimeFormat, TopologyMatch, TrustHostKeyParams,
    UseSshKeyParams, WireError, Workbook, WriteDatasetFileParams, WriteExportFileParams,
    WriteFiguresParams, WriteFitParams, WriteParametersParams, WrittenFile, WrittenFit,
};

// A preference save includes applying its theme. Reset holds the same lock
// through its window reset, so neither can undo part of the other's work.
static PREFERENCES_CHANGE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Whether this computer's settings set a 12- or 24-hour clock, with a bounded
/// asynchronous helper so startup can fall back when it stalls.
pub async fn time_format() -> TimeFormat {
    crate::clock::time_format().await
}

/// The Dataset wizard's edit, on this computer's own engine (ADR-0013).
pub async fn regenerate_dataset(
    params: RegenerateDatasetParams,
) -> Result<DatasetContent, WireError> {
    crate::active::host_engine()
        .call("regenerate_dataset", &params)
        .await
}

/// Redraw, on this computer's own engine (ADR-0013).
pub async fn propose_split(params: ProposeSplitParams) -> Result<Protocol, WireError> {
    crate::active::host_engine()
        .call("propose_split", &params)
        .await
}

/// Find custom topology's match, on this computer's own engine (ADR-0013, #223).
pub async fn match_topology(params: MatchTopologyParams) -> Result<TopologyMatch, WireError> {
    crate::active::host_engine()
        .call("match_topology", &params)
        .await
}

/// Submit's first-run time estimate, on this computer's own engine (ADR-0013).
pub async fn time_evaluations(params: TimeEvaluationsParams) -> Result<EvaluationTime, WireError> {
    crate::active::host_engine()
        .call("time_evaluations", &params)
        .await
}

/// A start's curves, on this computer's own engine whatever the Active
/// platform (ADR-0013, #88).
pub async fn simulate_start(params: SimulateStartParams) -> Result<StartSimulation, WireError> {
    crate::active::host_engine()
        .call("simulate_start", &params)
        .await
}

/// A topology's raw best vectors as they're shown, on this computer's own
/// engine whatever the Active platform (ADR-0007, ADR-0013, #287).
pub async fn canonical_parameters(
    params: CanonicalParametersParams,
) -> Result<CanonicalParameters, WireError> {
    crate::active::host_engine()
        .call("canonical_parameters", &params)
        .await
}

/// Each edge's rates at a voltage from a start's best vector, on this
/// computer's own engine whatever the Active platform (ADR-0013, #239).
pub async fn edge_rates(params: EdgeRatesParams) -> Result<EdgeRates, WireError> {
    crate::active::host_engine()
        .call("edge_rates", &params)
        .await
}

pub fn connection_state() -> ConnectionState {
    saved().state()
}

pub fn platforms() -> SavedPlatforms {
    saved().view()
}

pub async fn add_platform(params: AddPlatformParams) -> Result<PlatformRef, WireError> {
    let id = saved().add(params.form).await?;
    Ok(PlatformRef { id })
}

pub async fn edit_platform(params: EditPlatformParams) -> Result<(), WireError> {
    saved().edit(&params.id, params.form).await
}

/// Removes a saved platform, and what ⌘K remembers opening on it (#411).
pub async fn remove_platform(params: PlatformRef) -> Result<(), WireError> {
    saved().remove(&params.id).await?;
    let recents = crate::recently_opened::stored(crate::active::app());
    let forgot = tokio::task::spawn_blocking(move || recents.forget_platform(&params.id)).await;
    // The platform is gone either way; its pages can't show again, since ids aren't reused.
    if let Err(e) = forgot
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()))
    {
        tracing::error!("couldn't forget the removed platform's recently opened pages: {e}");
    }
    Ok(())
}

pub async fn connect_platform(params: PlatformRef) -> Result<(), WireError> {
    saved().connect(&params.id).await
}

pub async fn disconnect_platform() -> Result<(), WireError> {
    saved().disconnect().await
}

pub async fn set_launch_platform(params: LaunchPlatformParams) -> Result<(), WireError> {
    // The file lock can wait on another process, so not on an async worker.
    tokio::task::spawn_blocking(move || saved().set_launch(params.id.as_deref()))
        .await
        .unwrap_or_else(|e| Err(internal(format!("Couldn't save the launch choice: {e}."))))
}

pub async fn retry_connection() -> Result<(), WireError> {
    saved().retry_now().await
}

pub async fn trust_host_key(params: TrustHostKeyParams) -> Result<(), WireError> {
    saved().trust_host_key(&params.fingerprint).await
}

pub async fn forget_host_key(params: ForgetHostKeyParams) -> Result<(), WireError> {
    saved().forget_host_key(&params.fingerprint).await
}

pub async fn set_up_ssh_key() -> Result<(), WireError> {
    saved().set_up_ssh_key().await
}

pub async fn add_ssh_key(params: AddSshKeyParams) -> Result<(), WireError> {
    saved().add_ssh_key(params.password).await
}

pub async fn use_ssh_key(params: UseSshKeyParams) -> Result<(), WireError> {
    saved().use_ssh_key(&params.identity_file).await
}

/// The logs folder holds `app.log` and what each engine wrote to stderr.
pub fn open_logs_folder() -> Result<(), WireError> {
    let folder = crate::active::app()
        .path()
        .app_log_dir()
        .map_err(|e| internal(format!("Couldn't find the logs folder: {e}.")))?;
    open_folder(&folder).map_err(|e| internal(format!("Couldn't open {}: {e}.", folder.display())))
}

/// What a report holds now, for Report a problem…'s panel (#126).
pub async fn report_preview() -> ReportPreview {
    tokio::task::spawn_blocking(|| {
        let facts = ReportFacts::now();
        let logs = facts.logs();
        ReportPreview {
            versions: facts.versions,
            platform: facts.platform.into(),
            log_lines: logs.iter().map(|l| l.lines as i64).sum(),
        }
    })
    .await
    .unwrap_or_else(|e| ReportPreview {
        versions: format!("ICMM {}", env!("CARGO_PKG_VERSION")),
        platform: format!("unknown: {e}"),
        log_lines: 0,
    })
}

/// Saves the report in Downloads, then opens ICMM's issue page filled in.
pub async fn save_report(params: SaveReportParams) -> Result<SavedReport, WireError> {
    let saved = tokio::task::spawn_blocking(move || write_report(&params))
        .await
        .unwrap_or_else(|e| Err(internal(format!("Couldn't save the report: {e}."))))?;
    let (report, link) = saved;
    open_with_os(std::ffi::OsStr::new(&link)).map_err(|e| {
        let message = format!(
            "Saved {} in Downloads, but couldn't open ICMM's issue page: {e}.",
            report.file
        );
        tracing::error!("{message}");
        internal(message)
    })?;
    Ok(report)
}

/// What every report says, as it is now.
struct ReportFacts {
    versions: String,
    platform: &'static str,
    /// User names on this computer and its platforms.
    names: Vec<String>,
    logs_dir: Option<std::path::PathBuf>,
}

impl ReportFacts {
    fn now() -> ReportFacts {
        let state = saved().state();
        let view = saved().view();
        let kind = view
            .active
            .as_deref()
            .and_then(|id| view.platforms.iter().find(|p| platform_id(p) == id))
            .map(|p| match p {
                SavedPlatform::Ssh { .. } => "ssh",
                SavedPlatform::Local { .. } => "local",
            });
        let mut names = crate::report::local_names(std::env::home_dir().as_deref());
        for p in &view.platforms {
            if let SavedPlatform::Ssh { user, jump, .. } = p {
                names.push(user.clone());
                names.extend(jump.iter().map(|j| j.user.clone()));
            }
        }
        ReportFacts {
            versions: crate::report::versions(
                env!("CARGO_PKG_VERSION"),
                state.engine_version.as_deref(),
                &crate::report::os(),
                crate::report::arch(std::env::consts::ARCH),
            ),
            platform: crate::report::platform(kind),
            names,
            logs_dir: crate::active::app().path().app_log_dir().ok(),
        }
    }

    fn logs(&self) -> Vec<crate::report::Log> {
        self.logs_dir
            .as_deref()
            .map(crate::report::newest_logs)
            .unwrap_or_default()
    }
}

fn platform_id(p: &SavedPlatform) -> &str {
    match p {
        SavedPlatform::Ssh { id, .. } | SavedPlatform::Local { id, .. } => id,
    }
}

/// Writes the report in Downloads; answers it and the issue page's link.
fn write_report(params: &SaveReportParams) -> Result<(SavedReport, String), WireError> {
    let name = crate::report::file_name(&params.stamp)
        .ok_or_else(|| internal(format!("Couldn't name a report for {:?}.", params.stamp)))?;
    let facts = ReportFacts::now();
    let logs = facts.logs();
    let report = crate::report::Report {
        failure: params.failure.as_ref(),
        page: params.page.as_ref(),
        versions: &facts.versions,
        platform: facts.platform,
        logs: &logs,
    };
    let redact = |text: &str| crate::report::redact(text, &facts.names);
    let text = redact(&crate::report::compose(&report));
    let link = crate::report::issue_link(
        &redact(&crate::report::title(params.failure.as_ref())),
        &redact(&crate::report::what_happened(&report)),
        &redact(&facts.versions),
    );
    let folder = crate::active::app()
        .path()
        .download_dir()
        .map_err(|e| internal(format!("Couldn't find the Downloads folder: {e}.")))?;
    std::fs::create_dir_all(&folder)
        .map_err(|e| internal(format!("Couldn't make {}: {e}.", folder.display())))?;
    let path = crate::report::unused(&folder, &name);
    std::fs::write(&path, text)
        .map_err(|e| internal(format!("Couldn't save {}: {e}.", path.display())))?;
    tracing::info!("saved a report: {}", path.display());
    // Show in Finder shows it.
    dataset_file::chose(&path);
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(name);
    Ok((
        SavedReport {
            path: tilde(&path),
            file,
        },
        link,
    ))
}

/// ICMM's releases page, where its newest version is: the one place it's
/// named, for every "Get the newest ICMM".
pub const RELEASES_URL: &str = "https://github.com/meschoening/icmm-dev/releases/latest";

/// Opens the releases page in the OS's web browser.
pub fn open_releases_page() -> Result<(), WireError> {
    open_with_os(std::ffi::OsStr::new(RELEASES_URL)).map_err(|e| {
        let message = format!("Couldn't open {RELEASES_URL}: {e}.");
        tracing::error!("{message}");
        internal(message)
    })
}

/// Where the logs are, as Settings shows them; the folder ICMM would make
/// when it can't find one.
pub fn logs_folder() -> LogsFolder {
    let path = match crate::active::app().path().app_log_dir() {
        Ok(dir) => crate::logging::shown(&dir, std::env::home_dir().as_deref(), cfg!(windows)),
        Err(e) => {
            tracing::warn!("couldn't find the logs folder: {e}");
            String::new()
        }
    };
    LogsFolder { path }
}

/// What This computer's paths show for `~`: on Windows its home folder in
/// full, so they're shown in Windows' own form; elsewhere they keep `~/`.
pub fn home_folder() -> HomeFolder {
    home_shown(std::env::home_dir().as_deref(), cfg!(windows))
}

fn home_shown(home: Option<&std::path::Path>, windows: bool) -> HomeFolder {
    HomeFolder {
        path: home.filter(|_| windows).map(|h| h.display().to_string()),
    }
}

/// Shows `folder` in the OS's file manager.
fn open_folder(folder: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(folder)?;
    open_with_os(folder.as_os_str())
}

/// Hands `target`, a folder or a web address, to the OS's opener: its file
/// manager or its web browser.
fn open_with_os(target: &std::ffi::OsStr) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    // Explorer exits with 1 even when it opened what it was given, so only
    // a spawn that fails is a failure. Its exit is collected off the main
    // thread, so no process is left behind.
    let mut child = std::process::Command::new(opener).arg(target).spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

fn internal(message: String) -> WireError {
    WireError::Internal {
        message,
        data: InternalData {
            log_ref: "app.log".into(),
        },
    }
}

pub fn preferences() -> Preferences {
    crate::preferences::stored(crate::active::app()).load()
}

pub async fn set_preferences(params: Preferences) -> Result<(), WireError> {
    let _change = PREFERENCES_CHANGE.lock().await;
    let app = crate::active::app();
    let store = crate::preferences::stored(app);
    tokio::task::spawn_blocking(move || store.save(&params).map(|()| params.theme))
        .await
        .unwrap_or_else(|e| Err(internal(format!("Couldn't save the preferences: {e}."))))
        .map(|theme| crate::preferences::apply_theme(app, theme))
}

pub fn run_marks(params: RunMarksParams) -> RunMarks {
    crate::run_marks::stored(crate::active::app()).load(&params.platform_id)
}

pub fn mark_runs(params: MarkRunsParams) -> Result<(), WireError> {
    crate::run_marks::stored(crate::active::app()).mark(&params)
}

pub fn recently_opened(params: RecentlyOpenedParams) -> RecentlyOpened {
    crate::recently_opened::stored(crate::active::app()).load(&params.platform_id)
}

pub fn record_opened(params: RecordOpenedParams) -> Result<(), WireError> {
    crate::recently_opened::stored(crate::active::app()).record(&params)
}

/// A run-ended notification, unless Notifications is off (#229): the page
/// words it, as Runs words the run's row.
pub fn show_notification(params: NotificationParams) -> Result<(), WireError> {
    use tauri_plugin_notification::NotificationExt;
    let app = crate::active::app();
    if !crate::preferences::stored(app).load().notifications {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(&params.title)
        .body(&params.body)
        .show()
        .map_err(|e| internal(format!("Couldn't send the notification: {e}.")))
}

pub fn send_test_notification() -> Result<(), WireError> {
    use tauri_plugin_notification::NotificationExt;
    crate::active::app()
        .notification()
        .builder()
        .title("ICMM")
        .body("Notifications are on. You’ll get one like this when a run completes or fails.")
        .show()
        .map_err(|e| internal(format!("Couldn't send the notification: {e}.")))
}

pub fn guard_quit(params: GuardQuitParams) {
    crate::quit::GUARD.set(params.guarded);
}

pub fn quit_app() {
    tracing::info!("quitting: the page discarded its changes");
    crate::quit::quit(crate::active::app());
}

/// Reset ICMM, step by step: the logs first, since another app can hold them
/// open, so a Reset they stop has changed nothing else. ICMM's key goes next,
/// when asked, while ICMM still knows the platforms that use it.
pub async fn reset_app(params: ResetParams) -> Result<(), WireError> {
    use crate::reset::{self, Step};
    let _change = PREFERENCES_CHANGE.lock().await;
    let app = crate::active::app();
    let failed = |message: String| {
        tracing::error!("{message}");
        internal(message)
    };
    tracing::info!("resetting ICMM");
    let logs = app.path().app_log_dir().map_err(|e| {
        failed(format!(
            "ICMM couldn’t find its logs folder: {e}. Nothing else was reset."
        ))
    })?;
    let logs = tokio::task::spawn_blocking(move || reset::delete_logs(&logs))
        .await
        .map_err(|e| failed(format!("Reset stopped: {e}.")))?;
    logs.map_err(|f| failed(reset::logs_unfinished(&f)))?;
    let steps: &[Step] = if params.delete_icmm_key {
        &[Step::Key, Step::Platforms, Step::Preferences, Step::Window]
    } else {
        &[Step::Platforms, Step::Preferences, Step::Window]
    };
    let unfinished = |step: Step, e: &dyn std::fmt::Display| {
        failed(reset::unfinished(steps, step, &e.to_string()))
    };
    if params.delete_icmm_key {
        let key = crate::connection::icmm_key::default_file()
            .ok_or("there’s no home folder")
            .map_err(|e| unfinished(Step::Key, &e))?;
        tokio::task::spawn_blocking(move || reset::delete_icmm_key(&key))
            .await
            .map_err(|e| unfinished(Step::Key, &e))?
            .map_err(|e| unfinished(Step::Key, &e))?;
        tracing::info!("deleted ICMM's key");
    }
    saved()
        .forget_all()
        .await
        .map_err(|e| unfinished(Step::Platforms, &e))?;
    crate::preferences::stored(app)
        .forget()
        .map_err(|e| unfinished(Step::Preferences, &e))?;
    crate::run_marks::stored(app)
        .forget()
        .map_err(|e| unfinished(Step::Preferences, &e))?;
    crate::recently_opened::stored(app)
        .forget()
        .map_err(|e| unfinished(Step::Preferences, &e))?;
    crate::preferences::apply_theme(app, Theme::System);
    crate::window::forget(app)
        .await
        .map_err(|e| unfinished(Step::Window, &e))?;
    tracing::info!(
        "ICMM was reset: its logs, saved platforms, preferences and window are forgotten"
    );
    Ok(())
}

pub fn ssh_keys() -> SshKeys {
    let keys = match std::env::home_dir() {
        Some(home) => private_keys(&home.join(".ssh"), "~/.ssh"),
        None => Vec::new(),
    };
    SshKeys { keys }
}

pub fn ssh_config_hosts() -> SshConfigHosts {
    let hosts = ssh_config::default_file()
        .map(|file| ssh_config::hosts(&file))
        .unwrap_or_default();
    SshConfigHosts { hosts }
}

pub async fn ssh_config_host(params: SshConfigHostParams) -> Result<SshConfigHost, WireError> {
    let alias = params.alias;
    let invalid = |message: String| WireError::Invalid {
        message: format!("ICMM can’t use Host {alias} as it is."),
        data: InvalidData {
            issues: vec![Issue {
                path: vec!["alias".into()],
                message,
                severity: Severity::Error,
            }],
        },
    };
    let Some(source) = ssh_config::Source::users() else {
        return Err(invalid(
            "There’s no home folder to find ~/.ssh/config in.".into(),
        ));
    };
    source.resolve(&alias).await.map_err(invalid)
}

pub async fn choose_file(params: ChooseParams) -> Chosen {
    choose(params, |dialog, answer| dialog.pick_file(answer)).await
}

/// The Dataset wizard's workbook, read on this computer (old ADR-0006).
pub async fn read_workbook(params: ReadWorkbookParams) -> Workbook {
    crate::workbook::read_workbook(&expand_home(&params.path)).await
}

pub async fn choose_folder(params: ChooseParams) -> Chosen {
    choose(params, |dialog, answer| dialog.pick_folder(answer)).await
}

/// Import's file: a `.zip` that Export saved.
pub async fn choose_dataset_file(params: ChooseParams) -> Chosen {
    choose(params, |dialog, answer| {
        dialog
            .add_filter("Dataset file", &[dataset_file::EXTENSION])
            .pick_file(answer)
    })
    .await
}

/// Import's read, on this computer's own engine (ADR-0013).
pub async fn read_dataset_file(params: ReadDatasetFileParams) -> Result<DatasetFile, WireError> {
    let path = expand_home(&params.path).to_string_lossy().into_owned();
    crate::active::host_engine()
        .call("read_dataset_file", &ReadDatasetFileParams { path })
        .await
}

/// Where Export saves, which only this dialog's answer can be: a file of one
/// of `formats`, the first proposed.
pub async fn choose_export_file(params: ExportFileParams) -> Chosen {
    let ExportFileParams {
        title,
        name,
        folder,
        formats,
    } = params;
    let chosen = choose(ChooseParams { title, folder }, move |dialog, answer| {
        formats
            .iter()
            .fold(dialog.set_file_name(&name), |dialog, format| {
                let (kind, extension) = filter_of(*format);
                dialog.add_filter(kind, &[extension])
            })
            .save_file(answer)
    })
    .await;
    if let Some(path) = &chosen.path {
        dataset_file::chose(&expand_home(path));
    }
    chosen
}

/// The save dialog's filter for a kind of file Export saves: its name and
/// extension.
fn filter_of(format: ExportFormat) -> (&'static str, &'static str) {
    match format {
        ExportFormat::Zip => ("Dataset file", dataset_file::EXTENSION),
        ExportFormat::Json => ("JSON", "json"),
        ExportFormat::Csv => ("CSV", "csv"),
    }
}

/// `path` expanded, once the save dialog answered it in this session: the
/// only place Export writes.
fn chosen_path(path: &str) -> Result<String, WireError> {
    let path = expand_home(path);
    if !dataset_file::was_chosen(&path) {
        return Err(not_chosen(
            "ICMM can only save where you chose.",
            "Choose where to save it in the save dialog.",
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Export's write, on this computer's own engine, to where the save dialog
/// answered.
pub async fn write_dataset_file(params: WriteDatasetFileParams) -> Result<WrittenFile, WireError> {
    let params = WriteDatasetFileParams {
        path: chosen_path(&params.path)?,
        ..params
    };
    crate::active::host_engine()
        .call("write_dataset_file", &params)
        .await
}

/// Export parameters…'s write (#344), on this computer's own engine, to
/// where the save dialog answered.
pub async fn write_parameters(params: WriteParametersParams) -> Result<WrittenFile, WireError> {
    let params = WriteParametersParams {
        path: chosen_path(&params.path)?,
        ..params
    };
    crate::active::host_engine()
        .call("write_parameters", &params)
        .await
}

/// Export fit…'s write (#344), on this computer's own engine, to where the
/// save dialog answered, with its traces beside it.
pub async fn write_fit(params: WriteFitParams) -> Result<WrittenFit, WireError> {
    let params = WriteFitParams {
        path: chosen_path(&params.path)?,
        ..params
    };
    crate::active::host_engine()
        .call("write_fit", &params)
        .await
}

/// The leaderboard's CSV or a run's config (#344), as the page made it, to
/// where the save dialog answered.
pub async fn write_export_file(params: WriteExportFileParams) -> Result<WrittenFile, WireError> {
    let params = WriteExportFileParams {
        path: chosen_path(&params.path)?,
        ..params
    };
    crate::active::host_engine()
        .call("write_export_file", &params)
        .await
}

/// Where Export figures… saves its folder (#342), which only this dialog's
/// answer can be: a save dialog, so the user names the folder it makes.
pub async fn choose_export_folder(params: ExportFolderParams) -> Chosen {
    let ExportFolderParams {
        title,
        name,
        folder,
    } = params;
    let chosen = choose(ChooseParams { title, folder }, move |dialog, answer| {
        dialog.set_file_name(&name).save_file(answer)
    })
    .await;
    if let Some(path) = &chosen.path {
        dataset_file::chose(&expand_home(path));
    }
    chosen
}

/// Export figures…'s write, on this computer's own engine, into the folder
/// the save dialog answered.
pub async fn write_figures(params: WriteFiguresParams) -> Result<WrittenFile, WireError> {
    let folder = expand_home(&params.folder);
    if !dataset_file::was_chosen(&folder) {
        return Err(WireError::Invalid {
            message: "ICMM can only save where you chose.".into(),
            data: InvalidData {
                issues: vec![Issue {
                    path: vec!["folder".into()],
                    message: "Choose where to save them in the save dialog.".into(),
                    severity: Severity::Error,
                }],
            },
        });
    }
    let params = WriteFiguresParams {
        folder: folder.to_string_lossy().into_owned(),
        ..params
    };
    crate::active::host_engine()
        .call("write_figures", &params)
        .await
}

/// Show in Finder, for a file or a folder of figures Export saved.
pub fn reveal_file(params: RevealParams) -> Result<(), WireError> {
    let path = expand_home(&params.path);
    if !dataset_file::was_chosen(&path) {
        return Err(not_chosen(
            "ICMM can only show a file it saved.",
            "Export saves the files this shows.",
        ));
    }
    dataset_file::reveal(&path)
        .map_err(|e| internal(format!("Couldn't show {}: {e}.", params.path)))
}

/// Show in Finder, for a run's log on This computer (#289).
pub fn reveal_log(params: RevealLogParams) -> Result<(), WireError> {
    let path = expand_home(&params.path);
    if !run_logs::is_run_log(&path) {
        return Err(not_chosen(
            "ICMM can only show a run's log here.",
            "The log view shows the logs of runs on this computer.",
        ));
    }
    dataset_file::reveal(&path)
        .map_err(|e| internal(format!("Couldn't show {}: {e}.", params.path)))
}

fn not_chosen(message: &str, issue: &str) -> WireError {
    WireError::Invalid {
        message: message.into(),
        data: InvalidData {
            issues: vec![Issue {
                path: vec!["path".into()],
                message: issue.into(),
                severity: Severity::Error,
            }],
        },
    }
}

type Answer = Box<dyn FnOnce(Option<FilePath>) + Send>;

/// Opens the OS's dialog without blocking the main thread, and waits for it.
async fn choose(params: ChooseParams, open: impl FnOnce(FileDialogBuilder<Wry>, Answer)) -> Chosen {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = crate::active::app()
        .dialog()
        .file()
        .set_title(&params.title);
    if let Some(folder) = &params.folder {
        dialog = dialog.set_directory(expand_home(folder));
    }
    open(
        dialog,
        Box::new(move |path| {
            let _ = tx.send(path);
        }),
    );
    let path = rx.await.ok().flatten().and_then(|p| p.into_path().ok());
    Chosen {
        path: path.as_deref().map(tilde),
    }
}

#[cfg(test)]
mod tests {
    use super::home_shown;
    use std::path::Path;

    #[test]
    fn only_windows_shows_the_home_folder_in_full() {
        let windows = home_shown(Some(Path::new(r"C:\Users\ada")), true);
        assert_eq!(windows.path.as_deref(), Some(r"C:\Users\ada"));
        assert_eq!(home_shown(Some(Path::new("/Users/ada")), false).path, None);
        assert_eq!(home_shown(None, true).path, None);
    }
}
