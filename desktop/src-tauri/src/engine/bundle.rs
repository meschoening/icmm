//! An **Engine bundle**'s archive, as `scripts/engine_bundle.py` writes it:
//! `<key>.tar.zst`, its sha256 in `<key>.tar.zst.sha256` beside it, holding
//! the bundle's contents with no top folder, `BUNDLE.json` first.
//!
//! Self-contained (std, serde, ruzstd and tar), so `build.rs` includes it too:
//! a release build checks that the app carries the engines it needs.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const MANIFEST: &str = "BUNDLE.json";
/// The newest glibc a cluster's bundle may need, `manylinux_2_28`'s: the
/// oldest a platform may have (`preflight`), McKelvey's 2.34 well above it.
pub const CLUSTER_GLIBC: (u32, u32) = (2, 28);
/// The least disk a file takes on McKelvey's NFS home.
const BLOCK: u64 = 4096;

/// One engine bundle's archive, and what it holds.
#[derive(Clone, Debug)]
pub struct Bundle {
    /// `<engine version>-<os>-<arch>-<content sha256[:12]>`: the name of the
    /// folder it installs into.
    pub key: String,
    /// The archive's sha256.
    pub sha256: String,
    pub archive: PathBuf,
    /// The archive's size.
    pub archive_bytes: u64,
    pub manifest: Manifest,
}

/// The parts of `BUNDLE.json` an install uses.
#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub key: String,
    pub protocol: String,
    /// How many files it holds, and their total size.
    pub files: u64,
    pub bytes: u64,
    /// The newest glibc any of its files needs, on Linux.
    #[serde(default)]
    pub glibc: Option<String>,
}

impl Bundle {
    /// The bundle in `archive`, with its sha256 from the file beside it.
    pub fn read(archive: &Path) -> Result<Bundle, String> {
        let failed =
            |e: &dyn std::fmt::Display| format!("Couldn’t read {}: {e}", archive.display());
        let name = archive.file_name().unwrap_or_default().to_string_lossy();
        let key = name
            .strip_suffix(".tar.zst")
            .ok_or_else(|| failed(&"it isn’t a .tar.zst"))?
            .to_owned();
        let sha_file = format!("{}.sha256", archive.display());
        let sha256 = std::fs::read_to_string(&sha_file)
            .map_err(|e| failed(&e))?
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned();
        let archive_bytes = std::fs::metadata(archive).map_err(|e| failed(&e))?.len();
        let manifest = read_manifest(archive).map_err(|e| failed(&e))?;
        if manifest.key != key {
            return Err(failed(&format!("its {MANIFEST} is for {}", manifest.key)));
        }
        Ok(Bundle {
            key,
            sha256,
            archive: archive.to_owned(),
            archive_bytes,
            manifest,
        })
    }

    /// `<os>-<arch>`, as the key spells it.
    pub fn target(&self) -> &str {
        target_of(&self.key).unwrap_or_default()
    }

    /// The interpreter, relative to the bundle's folder.
    pub fn interpreter(&self) -> &'static str {
        if self.target().starts_with("windows-") {
            "python/python.exe"
        } else {
            "python/bin/python3.12"
        }
    }

    /// Whether it runs on every cluster `preflight` lets install it: one
    /// built for `manylinux_2_28`, needing no newer glibc. If not, why, in
    /// one sentence.
    pub fn runs_on_clusters(&self) -> Result<(), String> {
        let (major, minor) = CLUSTER_GLIBC;
        let Some(glibc) = &self.manifest.glibc else {
            return Err(format!(
                "{} doesn’t record the glibc it needs, so it may not be built for \
                 manylinux_2_28.",
                self.key
            ));
        };
        let version: Option<Vec<u32>> = glibc.split('.').map(|p| p.parse().ok()).collect();
        match version.as_deref() {
            Some([a, b, ..]) if (*a, *b) <= (major, minor) => Ok(()),
            _ => Err(format!(
                "{} needs glibc {glibc}, newer than manylinux_2_28’s {major}.{minor}, so \
                 clusters with an older glibc couldn’t run it.",
                self.key
            )),
        }
    }

    /// The disk an install takes while it runs: the archive, and the files it
    /// unpacks, each at least a block.
    pub fn install_bytes(&self) -> u64 {
        self.archive_bytes + self.manifest.bytes + self.manifest.files * BLOCK
    }
}

/// `BUNDLE.json`, the archive's first file.
fn read_manifest(archive: &Path) -> Result<Manifest, String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let decoder = ruzstd::decoding::StreamingDecoder::new(std::io::BufReader::new(file))
        .map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(decoder);
    let mut entries = tar.entries().map_err(|e| e.to_string())?;
    let mut first = entries
        .next()
        .ok_or("it’s empty")?
        .map_err(|e| e.to_string())?;
    if first.path().map_err(|e| e.to_string())?.as_ref() != Path::new(MANIFEST) {
        return Err(format!("{MANIFEST} isn’t its first file"));
    }
    let mut text = String::new();
    first.read_to_string(&mut text).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// `<os>-<arch>` in a key: what's between the version and the digest.
fn target_of(key: &str) -> Option<&str> {
    let (rest, _digest) = key.rsplit_once('-')?;
    let (version_os, _arch) = rest.rsplit_once('-')?;
    Some(&rest[version_os.rfind('-')? + 1..])
}

/// The bundle in `dirs` for `target` (`<os>-<arch>`) at `protocol`; the
/// newest, when a build folder holds several. Without one, what it found
/// instead, as one raw line.
pub fn find(dirs: &[PathBuf], target: &str, protocol: &str) -> Result<Bundle, String> {
    let mut found: Vec<(std::time::SystemTime, Bundle)> = Vec::new();
    let mut unread = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(key) = name.strip_suffix(".tar.zst") else {
                continue;
            };
            if target_of(key) != Some(target) {
                continue;
            }
            match Bundle::read(&path) {
                Ok(bundle) if bundle.manifest.protocol == protocol => {
                    let modified = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    found.push((modified, bundle));
                }
                Ok(bundle) => unread.push(format!(
                    "{} is for wire {}",
                    bundle.key, bundle.manifest.protocol
                )),
                Err(e) => unread.push(e),
            }
        }
    }
    found
        .into_iter()
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, bundle)| bundle)
        .ok_or_else(|| {
            let why: String = unread.iter().map(|e| format!(" · {e}")).collect();
            format!("no engine for {target} at wire {protocol}{why}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux_bundle(glibc: Option<&str>) -> Bundle {
        let key = "0.1.0-linux-x86_64-a16442e3a192";
        Bundle {
            key: key.to_owned(),
            sha256: "0".repeat(64),
            archive: PathBuf::from(format!("{key}.tar.zst")),
            archive_bytes: 1,
            manifest: Manifest {
                key: key.to_owned(),
                protocol: "1.2".to_owned(),
                files: 1,
                bytes: 1,
                glibc: glibc.map(str::to_owned),
            },
        }
    }

    #[test]
    fn a_bundle_needing_no_newer_glibc_than_manylinux_2_28_runs_on_clusters() {
        for glibc in ["2.28", "2.17", "2.9", "2.2.5"] {
            assert_eq!(
                linux_bundle(Some(glibc)).runs_on_clusters(),
                Ok(()),
                "{glibc}"
            );
        }
    }

    #[test]
    fn a_bundle_needing_a_newer_glibc_is_refused_naming_what_it_needs() {
        let why = linux_bundle(Some("2.35")).runs_on_clusters().unwrap_err();

        assert!(why.contains("0.1.0-linux-x86_64-a16442e3a192"), "{why}");
        assert!(why.contains("glibc 2.35"), "{why}");
        assert!(why.contains("manylinux_2_28"), "{why}");
    }

    #[test]
    fn a_bundle_that_doesnt_record_its_glibc_is_refused() {
        let why = linux_bundle(None).runs_on_clusters().unwrap_err();

        assert!(why.contains("doesn’t record"), "{why}");
    }
}
