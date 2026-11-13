/*
 * Disk helpers for the plugin API. A plugin's data folder is used only when it and `plugins-data`
 * are plain folders: a junction or symlink there could point a plugin's writes anywhere on disk.
 */

// -- Library Imports --
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

// -- Local Imports --
use crate::plugins::frame_host::is_reparse_point;
use crate::plugins::install::rename_with_retry;
use crate::plugins::paths::data_dir;

/// Creates `path` when missing, with its parents when `parents`. Refuses anything there that is not
/// a plain folder.
fn plain_dir(path: &Path, parents: bool) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_reparse_point(&meta) => {
            Err(io::Error::other("the folder is a reparse point"))
        }
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(io::Error::other("not a folder")),
        Err(e) if e.kind() == io::ErrorKind::NotFound && parents => fs::create_dir_all(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(path),
        Err(e) => Err(e),
    }
}

/// The plugin's data folder, created when missing. The id must already be validated.
pub fn ensure_data_dir(app_data: &Path, id: &str) -> io::Result<PathBuf> {
    let dir = data_dir(app_data, id);
    let root = dir
        .parent()
        .ok_or_else(|| io::Error::other("no data root"))?;
    plain_dir(root, true)?;
    plain_dir(&dir, false)?;
    Ok(dir)
}

/// Writes `bytes` to `<name>.tmp` beside `path`, syncs it and renames it over `path`, so a crash
/// leaves the old file or the new one. The temp file is removed when anything fails.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut name = path
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?
        .to_os_string();
    name.push(".tmp");
    let temp = path.with_file_name(name);
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename_with_retry(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::plugins::stage::Temp;

    const ID: &str = "com.example.demo";

    /// A directory junction (no privilege needed). False when the OS refuses, so the caller can skip.
    pub fn link_dir(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
            && link.exists()
    }

    #[test]
    fn the_data_folder_is_created_on_first_use_and_reused() {
        let t = Temp::new("api-files");
        let dir = ensure_data_dir(&t.0, ID).unwrap();
        assert_eq!(dir, data_dir(&t.0, ID));
        assert!(dir.is_dir());
        fs::write(dir.join("keep"), b"x").unwrap();
        assert_eq!(ensure_data_dir(&t.0, ID).unwrap(), dir);
        assert!(dir.join("keep").is_file());
    }

    #[test]
    fn a_junction_at_the_plugin_folder_is_refused() {
        let t = Temp::new("api-files");
        let elsewhere = t.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let dir = data_dir(&t.0, ID);
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        if !link_dir(&dir, &elsewhere) {
            eprintln!("skipped: cannot create a junction here");
            return;
        }
        assert!(ensure_data_dir(&t.0, ID).is_err());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[test]
    fn a_junction_at_plugins_data_is_refused() {
        let t = Temp::new("api-files");
        let elsewhere = t.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let root = data_dir(&t.0, ID).parent().unwrap().to_path_buf();
        if !link_dir(&root, &elsewhere) {
            eprintln!("skipped: cannot create a junction here");
            return;
        }
        assert!(ensure_data_dir(&t.0, ID).is_err());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }

    #[test]
    fn a_file_where_the_folder_belongs_is_refused() {
        let t = Temp::new("api-files");
        let dir = data_dir(&t.0, ID);
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        fs::write(&dir, b"").unwrap();
        assert!(ensure_data_dir(&t.0, ID).is_err());
    }

    #[test]
    fn an_atomic_write_replaces_the_file_and_leaves_no_temp() {
        let t = Temp::new("api-files");
        let path = t.0.join("kv.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(!t.0.join("kv.json.tmp").exists());
    }

    #[test]
    fn a_failed_atomic_write_keeps_the_target_and_removes_the_temp() {
        let t = Temp::new("api-files");
        // A non-empty folder where the file belongs makes the rename fail.
        let path = t.0.join("kv.json");
        fs::create_dir_all(path.join("inside")).unwrap();
        assert!(write_atomic(&path, b"new").is_err());
        assert!(path.join("inside").is_dir());
        assert!(!t.0.join("kv.json.tmp").exists());
    }
}
