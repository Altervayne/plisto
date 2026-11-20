/*
 * Free space on the volume a write stages its temp on, read through the verbatim path so a folder
 * past MAX_PATH works.
 */

// -- Library Imports --
use std::io;
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

// -- Local Imports --
use super::replace::{os_error, verbatim_units};

/// Bytes this user may still write on the volume holding the folder `dir`, quotas counted.
pub fn free_space(dir: &Path) -> io::Result<u64> {
    let mut wide = verbatim_units(dir)?;
    // A share root is accepted only with its trailing backslash.
    if wide.last() != Some(&u16::from(b'\\')) {
        wide.push(u16::from(b'\\'));
    }
    wide.push(0);
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and `free` outlives the call; the other outputs are not asked.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }
        .map_err(os_error)?;
    Ok(free)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_temp_folder_has_free_space_and_a_missing_folder_fails() {
        let temp = std::env::temp_dir();
        assert!(free_space(&temp).unwrap() > 0);
        let missing = temp.join(format!("plisto_space_missing_{}", std::process::id()));
        assert!(free_space(&missing).is_err());
    }
}
