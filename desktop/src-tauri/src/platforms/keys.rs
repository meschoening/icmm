//! The SSH keys in `~/.ssh`, for the platform form's SSH key menu.

use std::io::Read;
use std::path::Path;

/// The private keys in `dir`, by name, each written `<written_as>/<name>`.
/// A private key is a file whose first line is a PEM or OpenSSH private-key
/// header; `.pub` files, `known_hosts`, `config` and the rest aren't.
pub fn private_keys(dir: &Path, written_as: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| is_private_key(&entry.path()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| format!("{written_as}/{name}"))
        .collect()
}

fn is_private_key(path: &Path) -> bool {
    let mut head = [0u8; 64];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(n) = file.read(&mut head) else {
        return false;
    };
    let head = String::from_utf8_lossy(&head[..n]);
    let first = head.lines().next().unwrap_or_default().trim_end();
    first.starts_with("-----BEGIN ") && first.ends_with("PRIVATE KEY-----")
}
