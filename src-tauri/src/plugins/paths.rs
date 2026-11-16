/*
 * Plugin locations under the app data dir, plus the two validators every plugin path goes through:
 * ids (they become folder names) and manifest-relative paths (entry, icon). Both are lexical and
 * Windows-strict, so a name that is safe here is a real, non-device file on every platform.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};

const PLUGINS: &str = "plugins";
const PLUGINS_DATA: &str = "plugins-data";
const PLUGIN_KV: &str = "kv.json";
const PLUGIN_KV_BAD: &str = "kv.json.bad";
const PLUGIN_LOG: &str = "plugin.log";
const PLUGIN_LOG_OLD: &str = "plugin.log.1";
const PLUGIN_STDERR: &str = "stderr.log";
// Plisto's own plugin bookkeeping. Kept apart from `plugins/` so no file name there can read as an id.
const STATE: &str = "plugins-state";
const REGISTRY: &str = "registry.json";
const REGISTRY_BAD: &str = "registry.json.bad";
const SESSION: &str = ".session";
const SAFE_MODE: &str = ".safe-mode";
const INBOX: &str = "inbox";
// A leading dot cannot start an id segment, so no plugin id can collide with this folder.
const STAGING: &str = ".staging";

pub const ID_MIN: usize = 3;
pub const ID_MAX: usize = 64;
pub const REL_PATH_MAX: usize = 128;

// The reserved DOS device names. A component whose stem (the part before the first dot) matches one
// cannot be a real file on Windows, whatever its extension.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    "CONIN$", "CONOUT$",
];

/// The folder holding every installed plugin.
pub fn plugins_dir(app_data: &Path) -> PathBuf {
    app_data.join(PLUGINS)
}

/// One installed plugin's code folder. The id must already be validated.
pub fn plugin_dir(app_data: &Path, id: &str) -> PathBuf {
    plugins_dir(app_data).join(id)
}

/// A plugin's persistent data folder, kept outside its code folder so an update never touches it.
pub fn data_dir(app_data: &Path, id: &str) -> PathBuf {
    app_data.join(PLUGINS_DATA).join(id)
}

/// The file behind a plugin's `storage.*` calls.
pub fn kv_file(app_data: &Path, id: &str) -> PathBuf {
    data_dir(app_data, id).join(PLUGIN_KV)
}

/// Where a storage file that is not valid is moved, so its contents are never lost.
pub fn kv_bad_file(app_data: &Path, id: &str) -> PathBuf {
    data_dir(app_data, id).join(PLUGIN_KV_BAD)
}

/// The log a plugin writes through `log.write`, with Plisto's own lines about it.
pub fn log_file(app_data: &Path, id: &str) -> PathBuf {
    data_dir(app_data, id).join(PLUGIN_LOG)
}

/// The one rotated log kept beside `log_file`.
pub fn log_old_file(app_data: &Path, id: &str) -> PathBuf {
    data_dir(app_data, id).join(PLUGIN_LOG_OLD)
}

/// Where a native plugin's standard error goes, in its data folder.
pub fn stderr_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PLUGIN_STDERR)
}

/// Where the user drops `.plistoplugin` files and folders to install.
pub fn inbox_dir(app_data: &Path) -> PathBuf {
    plugins_dir(app_data).join(INBOX)
}

/// Scratch space for extraction and update swaps.
pub fn staging_dir(app_data: &Path) -> PathBuf {
    plugins_dir(app_data).join(STAGING)
}

/// The folder holding the registry, the session marker and the safe-mode flag.
pub fn state_dir(app_data: &Path) -> PathBuf {
    app_data.join(STATE)
}

pub fn registry_file(app_data: &Path) -> PathBuf {
    state_dir(app_data).join(REGISTRY)
}

/// Where an unreadable registry is moved so its contents are never lost.
pub fn registry_bad_file(app_data: &Path) -> PathBuf {
    state_dir(app_data).join(REGISTRY_BAD)
}

pub fn session_file(app_data: &Path) -> PathBuf {
    state_dir(app_data).join(SESSION)
}

pub fn safe_mode_file(app_data: &Path) -> PathBuf {
    state_dir(app_data).join(SAFE_MODE)
}

/// Whether a path component names a DOS device, with or without an extension.
pub fn is_reserved(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or("");
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
}

/// Checks a reverse-DNS plugin id: 3-64 chars of `[a-z0-9.-]`, at least two dot-separated segments,
/// no empty segment, no leading or trailing hyphen in a segment. Returns the one-line reason on failure.
pub fn validate_id(id: &str) -> Result<(), &'static str> {
    if id.len() < ID_MIN || id.len() > ID_MAX {
        return Err("must be 3 to 64 characters");
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return Err("may only contain a-z, 0-9, '.' and '-'");
    }
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2 {
        return Err("must be reverse-DNS with at least two dot-separated parts");
    }
    for seg in &segments {
        if seg.is_empty() {
            return Err("must not contain an empty part");
        }
        if seg.starts_with('-') || seg.ends_with('-') {
            return Err("a part must not start or end with '-'");
        }
        if is_reserved(seg) {
            return Err("a part is a reserved Windows device name");
        }
    }
    // `<id>.new` and `<id>.old` are the update swap folders; an id ending that way would alias another's.
    let last = segments[segments.len() - 1];
    if last == "new" || last == "old" {
        return Err("must not end in '.new' or '.old'");
    }
    Ok(())
}

/// Checks a manifest-relative file path: forward slashes only, `[A-Za-z0-9._-]` per component, no
/// empty, `.` or `..` component, no trailing dot, no device name. The character set also excludes
/// drive letters, stream markers (`:`), backslashes and absolute prefixes.
pub fn validate_rel_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Err("must not be empty");
    }
    if path.len() > REL_PATH_MAX {
        return Err("is too long");
    }
    if path.starts_with('/') {
        return Err("must be relative");
    }
    if path.contains('\\') {
        return Err("must use '/' separators");
    }
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
    {
        return Err("may only contain letters, digits, '.', '_', '-' and '/'");
    }
    for comp in path.split('/') {
        match comp {
            "" => return Err("must not contain an empty segment"),
            "." | ".." => return Err("must not contain '.' or '..' segments"),
            _ => {}
        }
        if comp.ends_with('.') {
            return Err("a segment must not end with '.'");
        }
        if is_reserved(comp) {
            return Err("a segment is a reserved Windows device name");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_nest_under_app_data() {
        let root = Path::new("data");
        assert_eq!(plugins_dir(root), root.join("plugins"));
        assert_eq!(
            plugin_dir(root, "com.a.b"),
            root.join("plugins").join("com.a.b")
        );
        assert_eq!(
            data_dir(root, "com.a.b"),
            root.join("plugins-data").join("com.a.b")
        );
        let data = root.join("plugins-data").join("com.a.b");
        assert_eq!(kv_file(root, "com.a.b"), data.join("kv.json"));
        assert_eq!(kv_bad_file(root, "com.a.b"), data.join("kv.json.bad"));
        assert_eq!(log_file(root, "com.a.b"), data.join("plugin.log"));
        assert_eq!(log_old_file(root, "com.a.b"), data.join("plugin.log.1"));
        assert_eq!(stderr_log_path(&data), data.join("stderr.log"));
        assert_eq!(inbox_dir(root), root.join("plugins").join("inbox"));
        assert_eq!(staging_dir(root), root.join("plugins").join(".staging"));
        let state = root.join("plugins-state");
        assert_eq!(state_dir(root), state);
        assert_eq!(registry_file(root), state.join("registry.json"));
        assert_eq!(registry_bad_file(root), state.join("registry.json.bad"));
        assert_eq!(session_file(root), state.join(".session"));
        assert_eq!(safe_mode_file(root), state.join(".safe-mode"));
    }

    #[test]
    fn valid_ids_pass() {
        for id in [
            "com.example.tandem",
            "a.b",
            "org.x-y.z9",
            "io.plisto.demo-1",
        ] {
            assert_eq!(validate_id(id), Ok(()), "{id}");
        }
    }

    #[test]
    fn invalid_ids_reject() {
        let long = format!("a.{}", "b".repeat(63));
        let cases = [
            "",
            "a.",
            "ab",
            "tandem",
            "Com.Example.Tandem",
            "com.exa mple.x",
            "com_example.x",
            "com..example",
            ".com.example",
            "com.example.",
            "com.-example.x",
            "com.example-.x",
            "con.example",
            "com.NUL.x",
            "com.lpt1.x",
            "com.example.new",
            "com.example.old",
            "com/example.x",
            "com\\example.x",
            "com.\u{e9}x.y",
            long.as_str(),
        ];
        for id in cases {
            assert!(validate_id(id).is_err(), "{id:?} should reject");
        }
    }

    #[test]
    fn id_length_bounds() {
        assert!(validate_id("a.b").is_ok());
        let max = format!("a.{}", "b".repeat(62));
        assert_eq!(max.len(), 64);
        assert!(validate_id(&max).is_ok());
    }

    #[test]
    fn console_devices_are_reserved_in_any_case_and_with_an_extension() {
        for name in ["CONIN$", "conout$", "ConIn$.txt", "CONOUT$.log.1"] {
            assert!(is_reserved(name), "{name}");
        }
        for name in ["CONIN", "conin$x", "conout$$", "CONOUT"] {
            assert!(!is_reserved(name), "{name}");
        }
    }

    #[test]
    fn valid_rel_paths_pass() {
        for p in [
            "index.html",
            "ui/main.html",
            "bin/tool.exe",
            "a-b_c/d.e.png",
            "icon.svg",
        ] {
            assert_eq!(validate_rel_path(p), Ok(()), "{p}");
        }
    }

    #[test]
    fn invalid_rel_paths_reject() {
        let long = format!("{}.html", "a".repeat(130));
        let cases = [
            "",
            "/index.html",
            "../index.html",
            "ui/../index.html",
            "./index.html",
            "ui/./index.html",
            "ui//index.html",
            "ui/",
            "C:/Windows/x.exe",
            "C:index.html",
            "c:\\x.exe",
            "ui\\index.html",
            "\\\\server\\share\\x.exe",
            "index.html:stream",
            "index.html.",
            "ui./index.html",
            "my page.html",
            "pa\u{e9}ge.html",
            "ui/con.html",
            "NUL",
            "aux.png",
            "ui/Lpt3.exe",
            "a\0b.html",
            long.as_str(),
        ];
        for p in cases {
            assert!(validate_rel_path(p).is_err(), "{p:?} should reject");
        }
    }
}
