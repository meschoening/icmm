// `COMMANDS`: the app's own commands, generated from the wire registry.
// Listing them turns on Tauri's ACL for them; the generated
// `capabilities/wire.json` allows each.
include!("src/wire/command_names.rs");

// What reads an engine bundle's archive, shared with the app.
#[path = "src/engine/bundle.rs"]
#[allow(dead_code)]
mod bundle;

fn main() {
    check_engines();
    // CI's generated assets may gain/remove files without changing existing ones.
    println!("cargo:rerun-if-env-changed=ICMM_APP_INPUTS_SHA256");

    // Generated permissions are outputs of COMMANDS (tracked by include! above).
    // Watching their parent makes checkout's cleanup invalidate every Rust link.
    // Hand-written permissions have their own watched source directory.
    println!("cargo:rerun-if-changed=permissions/custom");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(COMMANDS)
                .permissions_path_pattern("permissions/custom/**/*"),
        ),
    )
    .expect("failed to run tauri-build");

    // tauri-build embeds the application manifest, which declares the
    // Common-Controls v6 dependency, only into bin targets. Test harnesses
    // link the same windowing stack, which imports v6's `TaskDialogIndirect`,
    // so on Windows they load System32's comctl32 v5.82 and die at startup
    // with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before any test runs.
    // Embed the dependency everywhere, and turn it back off for the bin, which
    // already carries tauri-build's manifest (a second one fails with CVT1100).
    // `rustc-link-arg-tests` wouldn't do: it misses the lib's unit-test harness.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        println!("cargo:rustc-link-arg-bin=icmm-desktop=/MANIFEST:NO");
    }
}

/// A release build is an installer's: it must carry the engine bundles every
/// platform installs from, This computer's and the clusters' (ADR-0002), at
/// the app's protocol. Without one, the build fails here rather than every
/// connect to that kind of platform later.
fn check_engines() {
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    println!("cargo:rerun-if-changed=engines");
    let commands = std::fs::read_to_string("src/wire/commands.rs").expect("src/wire/commands.rs");
    let protocol = commands
        .lines()
        .find_map(|l| l.strip_prefix("pub const PROTOCOL_VERSION: &str = \""))
        .and_then(|rest| rest.strip_suffix("\";"))
        .expect("PROTOCOL_VERSION in src/wire/commands.rs");
    let host = match std::env::var("TARGET").unwrap_or_default().as_str() {
        "aarch64-apple-darwin" => "macos-arm64",
        "x86_64-apple-darwin" => "macos-x86_64",
        "x86_64-pc-windows-msvc" => "windows-x86_64",
        _ => "linux-x86_64",
    };
    let dirs = [std::path::PathBuf::from("engines")];
    if host != "linux-x86_64"
        && let Err(e) = bundle::find(&dirs, host, protocol)
    {
        panic!(
            "a release build carries the {host} engine bundle in desktop/src-tauri/engines/. \
             {e} Build it with scripts/engine_bundle.py."
        );
    }
    // The clusters' bundle, which a Linux app also runs as its host's.
    let cluster = bundle::find(&dirs, "linux-x86_64", protocol);
    if let Err(e) = cluster.and_then(|b| b.runs_on_clusters()) {
        panic!(
            "a release build carries the linux-x86_64 engine bundle that clusters run, built for \
             manylinux_2_28, in desktop/src-tauri/engines/. {e} Take CI's with \
             `uv run python scripts/ci_engine.py fetch`, or build it with \
             scripts/cluster_engine.sh."
        );
    }
}
