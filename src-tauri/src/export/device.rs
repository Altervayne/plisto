/*
 * MTP / device export target resolution (Windows only) — 1.6.0.
 *
 * A phone is not a filesystem, so the folder picker's path-returning dialog resolves null for a device
 * folder (indistinguishable from a cancel — the original bug). The shell folder dialog opened with
 * FOS_ALLNONSTORAGEITEMS returns a usable IShellItem for an MTP folder instead. Its durable reference
 * is the PIDL (ITEMIDLIST) hex-encoded here: proven on hardware (Pixel 10 Pro) to round-trip via
 * SHCreateItemFromIDList, where the SIGDN parsing-name string fails with E_INVALIDARG.
 *
 * This is P1: pick + validate only. The staged transfer (IFileOperation) is P2. Everything here runs on
 * the STA main thread — the caller hops there via run_on_main_thread (Trap A). Non-Windows gets stubs so
 * the command surface stays uniform.
 */

use crate::dto::DeviceTarget;

/// Opens the shell folder picker (device-capable) and returns the picked target, or None on cancel.
/// MUST be called on the STA main thread. Windows-only; other platforms return an error.
#[cfg(windows)]
pub fn pick_device_folder() -> Result<Option<DeviceTarget>, String> {
    win::pick().map_err(|e| e.to_string())
}

/// Whether a stored PIDL still resolves to a live shell item (the device is connected/reachable).
#[cfg(windows)]
pub fn device_reachable(pidl_hex: &str) -> bool {
    win::reachable(pidl_hex)
}

#[cfg(not(windows))]
pub fn pick_device_folder() -> Result<Option<DeviceTarget>, String> {
    Err("device export is only available on Windows".to_string())
}

#[cfg(not(windows))]
pub fn device_reachable(_pidl_hex: &str) -> bool {
    false
}

#[cfg(windows)]
mod win {
    use crate::dto::DeviceTarget;
    use windows::core::{Result, PWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, ILGetSize, SHCreateItemFromIDList,
        SHGetIDListFromObject, FOS_ALLNONSTORAGEITEMS, FOS_PICKFOLDERS, SIGDN, SIGDN_NORMALDISPLAY,
    };

    pub fn pick() -> Result<Option<DeviceTarget>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            // FOS_ALLNONSTORAGEITEMS is the critical flag: it lets the dialog return MTP folders, which
            // are non-filesystem shell items. Without it a phone folder comes back null.
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_ALLNONSTORAGEITEMS)?;
            if dialog.Show(HWND::default()).is_err() {
                return Ok(None); // a cancel is a normal Err from Show
            }
            let item: IShellItem = dialog.GetResult()?;
            let chain = breadcrumb(&item);

            // The durable token is the PIDL bytes, hex-encoded. Freed right after copying.
            let pidl = SHGetIDListFromObject(&item)?;
            let size = ILGetSize(Some(pidl)) as usize;
            let hex = to_hex(std::slice::from_raw_parts(pidl as *const u8, size));
            CoTaskMemFree(Some(pidl as *const core::ffi::c_void));

            Ok(Some(DeviceTarget {
                device_name: device_name(&chain),
                display: display_chain(&chain),
                pidl: hex,
            }))
        }
    }

    pub fn reachable(pidl_hex: &str) -> bool {
        let Some(bytes) = from_hex(pidl_hex) else {
            return false;
        };
        unsafe {
            let pidl = aligned_pidl(&bytes);
            SHCreateItemFromIDList::<IShellItem>(pidl.as_ptr() as *const ITEMIDLIST).is_ok()
        }
    }

    /// Copies the PIDL bytes into a 2-byte-aligned buffer, so reading them as an ITEMIDLIST is sound
    /// (the spike's raw `Vec<u8>` only worked because the allocator over-aligned).
    fn aligned_pidl(bytes: &[u8]) -> Vec<u16> {
        let mut buf = vec![0u16; bytes.len().div_ceil(2)];
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.as_mut_ptr() as *mut u8, bytes.len());
        }
        buf
    }

    unsafe fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
        let pw: PWSTR = item.GetDisplayName(kind).ok()?;
        let s = pw.to_string().ok();
        CoTaskMemFree(Some(pw.0 as *const core::ffi::c_void));
        s
    }

    /// The device/storage/folder breadcrumb, from the item up its parent chain to the desktop root.
    unsafe fn breadcrumb(item: &IShellItem) -> Vec<String> {
        let mut parts = Vec::new();
        if let Some(n) = display_name(item, SIGDN_NORMALDISPLAY) {
            parts.push(n);
        }
        let mut parent = item.GetParent();
        while let Ok(p) = parent {
            if let Some(n) = display_name(&p, SIGDN_NORMALDISPLAY) {
                parts.push(n);
            }
            parent = p.GetParent();
        }
        parts.reverse();
        parts
    }

    /// The device node: the third breadcrumb level (Desktop > This PC > **Device** > …), falling back to
    /// the last node when the chain is shorter (a non-device pick through the same dialog).
    fn device_name(chain: &[String]) -> String {
        chain
            .get(2)
            .or_else(|| chain.last())
            .cloned()
            .unwrap_or_default()
    }

    /// The human display path with the shell roots trimmed: "Pixel 10 Pro > Internal shared storage > …".
    fn display_chain(chain: &[String]) -> String {
        let start = if chain.len() > 2 { 2 } else { 0 };
        chain[start..].join(" > ")
    }

    fn to_hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    fn from_hex(s: &str) -> Option<Vec<u8>> {
        if s.len() % 2 != 0 {
            return None;
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn hex_round_trips() {
            let bytes = vec![0x00, 0x14, 0xff, 0x01, 0xab];
            assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        }

        #[test]
        fn from_hex_rejects_odd_length() {
            assert!(from_hex("abc").is_none());
        }

        #[test]
        fn device_name_prefers_third_level() {
            let chain = vec![
                "Desktop".to_string(),
                "This PC".to_string(),
                "Pixel 10 Pro".to_string(),
                "Internal shared storage".to_string(),
                "Music".to_string(),
            ];
            assert_eq!(device_name(&chain), "Pixel 10 Pro");
            assert_eq!(
                display_chain(&chain),
                "Pixel 10 Pro > Internal shared storage > Music"
            );
        }

        #[test]
        fn aligned_pidl_preserves_bytes() {
            let bytes = vec![1u8, 2, 3, 4, 5];
            let buf = aligned_pidl(&bytes);
            let back =
                unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, bytes.len()) };
            assert_eq!(back, &bytes[..]);
        }
    }
}
