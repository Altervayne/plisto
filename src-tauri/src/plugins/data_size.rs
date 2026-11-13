/*
 * How many bytes of saved data a plugin holds, for the uninstall prompt. The walk is iterative and
 * never follows a link, so a cyclic or hostile tree cannot loop it or lead it outside the data folder;
 * it stops after a fixed number of entries and reports what it counted, which is a bound and not an
 * error.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};

// -- Local Imports --
use super::frame_host::is_reparse_point;
use super::install_error::{ErrorCode, InstallError};
use super::paths::{data_dir, validate_id};

/// Entries (files and folders) visited before the walk stops.
pub const MAX_ENTRIES: usize = 100_000;

/// Total bytes of the regular files under the plugin's data folder; 0 when it does not exist.
pub fn data_size(app_data: &Path, id: &str) -> Result<u64, InstallError> {
    validate_id(id).map_err(|why| {
        InstallError::new(
            ErrorCode::NotFound,
            format!("{id} is not a plugin id: {why}"),
        )
    })?;
    Ok(walk(&data_dir(app_data, id), MAX_ENTRIES))
}

/// Sums the regular files under `root`, visiting at most `limit` entries. A link, junction or other
/// non-regular entry counts as an entry and adds nothing; an unreadable folder is skipped.
fn walk(root: &Path, limit: usize) -> u64 {
    let plain_root = fs::symlink_metadata(root).is_ok_and(|m| m.is_dir() && !is_reparse_point(&m));
    if !plain_root {
        return 0;
    }
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut pending: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read.filter_map(Result::ok) {
            if seen >= limit {
                return total;
            }
            seen += 1;
            let Ok(meta) = item.metadata() else {
                continue;
            };
            if is_reparse_point(&meta) {
                continue;
            }
            if meta.is_dir() {
                pending.push(item.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::stage::Temp;

    const ID: &str = "com.example.demo";

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    #[test]
    fn a_missing_folder_is_zero() {
        let t = Temp::new("data-size");
        assert_eq!(data_size(&t.0, ID).unwrap(), 0);
    }

    #[test]
    fn nested_files_are_summed() {
        let t = Temp::new("data-size");
        let data = data_dir(&t.0, ID);
        write(&data.join("kv.json"), 10);
        write(&data.join("a").join("b.bin"), 100);
        write(&data.join("a").join("c").join("d.bin"), 1000);
        fs::create_dir_all(data.join("empty")).unwrap();
        assert_eq!(data_size(&t.0, ID).unwrap(), 1110);
        // Another plugin's data is not counted.
        write(&data_dir(&t.0, "com.example.other").join("x"), 5);
        assert_eq!(data_size(&t.0, ID).unwrap(), 1110);
    }

    #[test]
    fn an_invalid_id_is_refused() {
        let t = Temp::new("data-size");
        for id in ["", "..", "a/b.c", "C:\\x.y"] {
            let err = data_size(&t.0, id).unwrap_err();
            assert_eq!(err.code, ErrorCode::NotFound, "{id:?}");
        }
    }

    #[test]
    fn the_walk_stops_at_the_entry_limit() {
        let t = Temp::new("data-size");
        let data = data_dir(&t.0, ID);
        for n in 0..10 {
            write(&data.join(format!("f{n}")), 3);
        }
        assert_eq!(walk(&data, 4), 12);
        assert_eq!(walk(&data, 10), 30);
        assert_eq!(walk(&data, 1000), 30);
    }

    /// A directory junction needs no privilege on Windows, unlike a symlink.
    #[cfg(windows)]
    fn link_dir(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_is_not_followed() {
        let t = Temp::new("data-size");
        let outside = t.0.join("outside");
        write(&outside.join("big.bin"), 5000);
        let data = data_dir(&t.0, ID);
        write(&data.join("own.bin"), 10);
        if !link_dir(&data.join("link"), &outside) {
            eprintln!("skipped: a directory junction could not be created here");
            return;
        }
        assert_eq!(data_size(&t.0, ID).unwrap(), 10);
        // A cycle back to the data folder does not loop either.
        let _ = link_dir(&data.join("back"), &data);
        assert_eq!(data_size(&t.0, ID).unwrap(), 10);
        // The data folder itself being a link counts nothing.
        let other = data_dir(&t.0, "com.example.linked");
        if link_dir(&other, &outside) {
            assert_eq!(data_size(&t.0, "com.example.linked").unwrap(), 0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_not_followed() {
        let t = Temp::new("data-size");
        let outside = t.0.join("outside");
        write(&outside.join("big.bin"), 5000);
        let data = data_dir(&t.0, ID);
        write(&data.join("own.bin"), 10);
        std::os::unix::fs::symlink(&outside, data.join("link")).unwrap();
        assert_eq!(data_size(&t.0, ID).unwrap(), 10);
    }
}
