// The stills: one PNG per kind and theme, named with the build key it was drawn under, so a still
// of another build is never found and is removed by the next write.

// -- Library Imports --
use std::fs;
use std::io;
use std::path::Path;

// -- Local Imports --
use super::{check_ids, ensure_key, io_text, lock, open, write_atomic, write_store, VisTheme};
use super::{PNG_SIGNATURE, STILLS_DIR, STILL_MAX};

// The prefix keeps a kind named like a Windows device (con, nul) from naming a device file.
fn still_name(kind: &str, theme: VisTheme, key: &str) -> String {
    format!("k-{kind}.{}.{key}.png", theme.name())
}

/// Removes every still not made under `key`, and any temp file a dead write left.
pub(super) fn prune_stills(dir: &Path, key: &str) {
    let suffix = format!(".{key}.png");
    let Ok(items) = fs::read_dir(dir.join(STILLS_DIR)) else {
        return;
    };
    for item in items.flatten() {
        if !item.file_name().to_string_lossy().ends_with(&suffix) {
            let _ = fs::remove_file(item.path());
        }
    }
}

/// Stores the PNG still of `kind` in `theme` under the current build key, replacing the last one.
pub fn thumb_put(
    app_data: &Path,
    id: &str,
    kind: &str,
    theme: VisTheme,
    png: &[u8],
) -> Result<(), String> {
    check_ids(id, kind)?;
    if png.len() > STILL_MAX {
        return Err("the still is too large".to_string());
    }
    if !png.starts_with(&PNG_SIGNATURE) {
        return Err("the still is not a PNG".to_string());
    }
    ensure_key(app_data, id)?;
    let _guard = lock();
    let (dir, mut store) = open(app_data, id)?;
    // Persists the key and drops stale records before the new still lands.
    write_store(&dir, &mut store).map_err(io_text)?;
    let stills = dir.join(STILLS_DIR);
    fs::create_dir_all(&stills).map_err(io_text)?;
    prune_stills(&dir, &store.key);
    write_atomic(&stills.join(still_name(kind, theme, &store.key)), png).map_err(io_text)
}

/// The stored still of `kind` in `theme` under the current build key, if any.
pub fn thumb_get(
    app_data: &Path,
    id: &str,
    kind: &str,
    theme: VisTheme,
) -> Result<Option<Vec<u8>>, String> {
    check_ids(id, kind)?;
    ensure_key(app_data, id)?;
    let _guard = lock();
    let (dir, store) = open(app_data, id)?;
    let path = dir.join(STILLS_DIR).join(still_name(kind, theme, &store.key));
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_text(e)),
    }
}
