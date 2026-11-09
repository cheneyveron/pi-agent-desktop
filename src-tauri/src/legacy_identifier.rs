//! The fork ships as `com.solidtensor.pi-agent` so it can sit beside upstream
//! Pi Agent (`com.abcwyc.pi-agent`) without sharing its data. Installs from
//! before the rename auto-update in place, so on first launch their app data
//! and webview storage (localStorage) are copied over from the old id.
//!
//! Runs before the Tauri builder, so paths are resolved from the environment.
//! Copy, never move: the old data stays for rollback and for upstream.

use std::{
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
};

pub const IDENTIFIER: &str = "com.solidtensor.pi-agent";
const LEGACY_IDENTIFIER: &str = "com.abcwyc.pi-agent";

/// Webview disk caches (rebuilt, and cleared on upgrade anyway) and the Linux
/// instance lock files, which may name a running upstream app's pid.
const SKIPPED_NAMES: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "WebKitCache",
    "pi-agent.lock",
    "focus.request",
];

/// Copies each legacy data path whose new-id counterpart does not exist yet.
/// Best effort; returns log lines for `desktop.log` once the app is up.
pub fn migrate() -> Vec<String> {
    let mut notes = Vec::new();
    for (old, new) in legacy_paths() {
        match migrate_path(&old, &new) {
            Ok(false) => {}
            Ok(true) => notes.push(format!("copied {} -> {}", old.display(), new.display())),
            Err(error) => notes.push(format!("copy {} failed: {error}", old.display())),
        }
    }
    for note in &notes {
        eprintln!("legacy identifier migration: {note}");
    }
    notes
}

/// (old, new) pairs: `<dir>/<id><suffix>` for each per-app data location.
fn legacy_paths() -> Vec<(PathBuf, PathBuf)> {
    let mut dirs: Vec<(PathBuf, &str)> = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(library) = env_dir("HOME").map(|home| home.join("Library")) {
        dirs.push((library.join("Application Support"), ""));
        dirs.push((library.join("WebKit"), ""));
        dirs.push((library.join("Preferences"), ".plist"));
    }
    #[cfg(windows)]
    dirs.extend(["APPDATA", "LOCALAPPDATA"].into_iter().filter_map(env_dir).map(|dir| (dir, "")));
    #[cfg(target_os = "linux")]
    {
        let home = env_dir("HOME");
        let config = env_dir("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|h| h.join(".config")));
        let data = env_dir("XDG_DATA_HOME").or_else(|| home.map(|h| h.join(".local").join("share")));
        dirs.extend([config, data].into_iter().flatten().map(|dir| (dir, "")));
    }
    dirs.into_iter()
        .map(|(dir, suffix)| {
            (
                dir.join(format!("{LEGACY_IDENTIFIER}{suffix}")),
                dir.join(format!("{IDENTIFIER}{suffix}")),
            )
        })
        .collect()
}

fn env_dir(name: &str) -> Option<PathBuf> {
    env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// Copies `old` to `new` when `new` is absent and `old` present; returns
/// whether it copied. The copy is built under a hidden sibling name and renamed
/// into place, so a crash mid-copy leaves no half-filled `new` to block a retry.
fn migrate_path(old: &Path, new: &Path) -> io::Result<bool> {
    if fs::symlink_metadata(new).is_ok() || !old.exists() {
        return Ok(false);
    }
    let mut temp_name = OsString::from(".");
    temp_name.push(new.file_name().unwrap_or_default());
    temp_name.push(".migrating");
    let temp = new.with_file_name(temp_name);
    remove_path(&temp)?; // leftover from an interrupted copy
    let copied = if old.is_dir() { copy_dir(old, &temp) } else { fs::copy(old, &temp).map(drop) };
    if let Err(error) = copied.and_then(|()| fs::rename(&temp, new)) {
        let _ = remove_path(&temp);
        return Err(error);
    }
    Ok(true)
}

fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Recursive copy that keeps symlinks as links (skips them off Unix) instead
/// of following them out of the tree.
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if SKIPPED_NAMES.iter().any(|name| entry.file_name() == *name) {
            continue;
        }
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&source, &target)?;
        } else if kind.is_file() {
            fs::copy(&source, &target)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&source)?, &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("pi-agent-legacy-id-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn identifier_matches_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    #[test]
    fn copies_nested_tree_and_keeps_the_old_one() {
        let root = temp_root("copy");
        let (old, new) = (root.join("old"), root.join("new"));
        write(&old.join("backends.json"), "b");
        write(&old.join("WebsiteData/LocalStorage/origin.sqlite3"), "ls");
        write(&old.join("EBWebView/Default/Cache/blob"), "cache");

        assert!(migrate_path(&old, &new).unwrap());
        assert_eq!(read(&new.join("backends.json")), "b");
        assert_eq!(read(&new.join("WebsiteData/LocalStorage/origin.sqlite3")), "ls");
        assert!(!new.join("EBWebView/Default/Cache").exists());
        assert!(new.join("EBWebView/Default").is_dir());
        assert_eq!(read(&old.join("backends.json")), "b");
        assert!(!root.join(".new.migrating").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copies_a_single_file() {
        let root = temp_root("file");
        let (old, new) = (root.join("old.plist"), root.join("new.plist"));
        write(&old, "prefs");
        assert!(migrate_path(&old, &new).unwrap());
        assert_eq!(read(&new), "prefs");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn leaves_an_existing_new_path_untouched() {
        let root = temp_root("exists");
        let (old, new) = (root.join("old"), root.join("new"));
        write(&old.join("backends.json"), "old");
        write(&new.join("ui-prefs.json"), "new");
        assert!(!migrate_path(&old, &new).unwrap());
        assert!(!new.join("backends.json").exists());
        assert_eq!(read(&new.join("ui-prefs.json")), "new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_old_path_is_a_no_op() {
        let root = temp_root("missing");
        let new = root.join("new");
        assert!(!migrate_path(&root.join("old"), &new).unwrap());
        assert!(!new.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn replaces_a_leftover_temp_copy() {
        let root = temp_root("leftover");
        let (old, new) = (root.join("old"), root.join("new"));
        write(&old.join("backends.json"), "b");
        write(&root.join(".new.migrating/partial"), "stale");
        assert!(migrate_path(&old, &new).unwrap());
        assert_eq!(read(&new.join("backends.json")), "b");
        assert!(!new.join("partial").exists());
        assert!(!root.join(".new.migrating").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_symlinks_as_links() {
        let root = temp_root("symlink");
        let (old, new) = (root.join("old"), root.join("new"));
        write(&root.join("outside/secret"), "s");
        fs::create_dir_all(&old).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), old.join("link")).unwrap();
        assert!(migrate_path(&old, &new).unwrap());
        let meta = fs::symlink_metadata(new.join("link")).unwrap();
        assert!(meta.file_type().is_symlink());
        let _ = fs::remove_dir_all(&root);
    }
}
