// The reset trial: a marker file written when a kind starts its trial and removed when it ends. A
// marker left on disk means the process died during the trial, which reads as a lost graphics
// context for that kind.

// -- Library Imports --
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

// -- Local Imports --
use super::{
    check_ids, ensure_key, io_text, lock, open, read_store, write_atomic, write_store, KindRec,
    MarkRec, VisMark, SWEPT, TRIAL_PREFIX,
};
use crate::plugins::paths::{vis_store_dir, vis_store_root};
use crate::plugins::visualizer_decl::valid_kind_id;

/// Turns each trial marker still on disk into a `graphics_reset` mark under the key it was begun
/// with, once per process. Runs under the lock.
pub(super) fn sweep_trials(app_data: &Path, swept: &AtomicBool) {
    if swept.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(plugins) = fs::read_dir(vis_store_root(app_data)) else {
        return;
    };
    for item in plugins.flatten() {
        let dir = item.path();
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut store = read_store(&dir);
        let mut found = false;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(kind) = name.strip_prefix(TRIAL_PREFIX) else {
                continue;
            };
            if valid_kind_id(kind) {
                let key = fs::read_to_string(entry.path()).unwrap_or_default();
                store.marks.retain(|m| !(m.kind == kind && m.mark == VisMark::GraphicsReset));
                store.back_on.retain(|b| b.kind != kind);
                store.marks.push(MarkRec {
                    kind: kind.to_string(),
                    mark: VisMark::GraphicsReset,
                    key: key.trim().to_string(),
                });
                found = true;
            }
            let _ = fs::remove_file(entry.path());
        }
        if found {
            let _ = write_store(&dir, &mut store);
        }
    }
}

/// Writes the reset trial marker for `kind`, holding the current build key, and returns true. A
/// kind already trialed under this build gets no marker and false. A marker found at the next
/// process's first read means the trial never ended.
pub fn trial_begin(app_data: &Path, id: &str, kind: &str) -> Result<bool, String> {
    check_ids(id, kind)?;
    ensure_key(app_data, id)?;
    let _guard = lock();
    // The sweep runs first, so this process's own marker is never mistaken for a leftover.
    sweep_trials(app_data, &SWEPT);
    let (dir, store) = open(app_data, id)?;
    if store.is_trialed(kind) {
        return Ok(false);
    }
    fs::create_dir_all(&dir).map_err(io_text)?;
    let marker = dir.join(format!("{TRIAL_PREFIX}{kind}"));
    write_atomic(&marker, store.key.as_bytes()).map_err(io_text)?;
    Ok(true)
}

/// Removes the reset trial marker for `kind`. With `passed`, the kind is also recorded as trialed
/// under the key the trial began with, so the trial is not run again for that build.
pub fn trial_end(app_data: &Path, id: &str, kind: &str, passed: bool) -> Result<(), String> {
    check_ids(id, kind)?;
    if passed {
        ensure_key(app_data, id)?;
    }
    let _guard = lock();
    let dir = vis_store_dir(app_data, id);
    let marker = dir.join(format!("{TRIAL_PREFIX}{kind}"));
    let begun_under = fs::read_to_string(&marker).ok();
    match fs::remove_file(&marker) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(io_text(e)),
        _ => {}
    }
    if !passed {
        return Ok(());
    }
    let (dir, mut store) = open(app_data, id)?;
    let key = begun_under.map_or(store.key.clone(), |k| k.trim().to_string());
    store.trialed.retain(|t| t.kind != kind);
    store.trialed.push(KindRec {
        kind: kind.to_string(),
        key,
    });
    write_store(&dir, &mut store).map_err(io_text)
}
