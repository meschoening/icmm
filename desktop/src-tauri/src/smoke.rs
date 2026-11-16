//! The launch smoke (`ICMM_SMOKE`, #263) runs only as a test identity, so it
//! never opens the ICMM of whoever runs the gate: Tauri keys the app's
//! settings, logs, saved platforms and engine by identifier.
//! `scripts/ci/launch_smoke.py` builds and launches that identity.

/// When set, the app quits as soon as its page has loaded: CI's launch smoke.
pub const ENV: &str = "ICMM_SMOKE";
/// The production app's identifier, which every test identity extends.
const PRODUCTION_ID: &str = "org.meschoening.icmm";

/// Whether this launch is the smoke.
pub fn running() -> bool {
    std::env::var_os(ENV).is_some()
}

/// What the app prints as it starts the smoke, which the launcher checks.
pub fn identity_line(identifier: &str) -> String {
    format!("{ENV}: identity {identifier}")
}

/// Why this build mustn't run the smoke, if it mustn't. A smoke runs only as
/// a test identity (`org.meschoening.icmm.<name>`) whose windows are all
/// incognito, so WebKit keeps no website data.
pub fn refusal(config: &tauri::Config) -> Option<String> {
    let id = &config.identifier;
    let test_name = id
        .strip_prefix(PRODUCTION_ID)
        .and_then(|rest| rest.strip_prefix('.'));
    if test_name.is_none_or(str::is_empty) {
        return Some(format!(
            "won't run as {id}: the smoke runs only as a test identity, {PRODUCTION_ID}.<name>"
        ));
    }
    if let Some(window) = config.app.windows.iter().find(|w| !w.incognito) {
        return Some(format!(
            "won't run as {id}: its {} window isn't incognito",
            window.label
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(identifier: &str, incognito: &[bool]) -> tauri::Config {
        let windows: Vec<_> = incognito
            .iter()
            .enumerate()
            .map(|(i, on)| serde_json::json!({"label": format!("w{i}"), "incognito": on}))
            .collect();
        serde_json::from_value(serde_json::json!({
            "identifier": identifier,
            "app": {"windows": windows},
        }))
        .unwrap()
    }

    #[test]
    fn the_production_app_never_runs_the_smoke() {
        let checked_in: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let refused = refusal(&checked_in).unwrap();
        assert!(
            refused.starts_with("won't run as org.meschoening.icmm:"),
            "{refused}"
        );
        assert!(refusal(&config("org.meschoening.icmm", &[true])).is_some());
    }

    #[test]
    fn only_a_test_identity_of_this_app_runs_the_smoke() {
        for id in [
            "com.ionchannel.icmm.desktop",
            "org.meschoening.icmm.",
            "org.meschoening.icmmsmoke",
            "org.meschoening.icmm2.smoke",
            "smoke.org.meschoening.icmm",
        ] {
            assert!(refusal(&config(id, &[true])).is_some(), "{id}");
        }
        assert_eq!(
            refusal(&config("org.meschoening.icmm.smoke", &[true])),
            None
        );
        assert_eq!(
            refusal(&config("org.meschoening.icmm.t235", &[true, true])),
            None
        );
    }

    #[test]
    fn the_identity_line_is_what_the_launcher_reads() {
        // scripts/ci/launch_smoke.py's `run` looks for this line.
        assert_eq!(
            identity_line("org.meschoening.icmm.smoke"),
            "ICMM_SMOKE: identity org.meschoening.icmm.smoke"
        );
    }

    #[test]
    fn a_window_that_keeps_a_webkit_store_refuses_the_smoke() {
        assert_eq!(
            refusal(&config("org.meschoening.icmm.smoke", &[true, false])),
            Some("won't run as org.meschoening.icmm.smoke: its w1 window isn't incognito".into())
        );
    }
}
