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

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::dto::{DeviceTarget, ExportProgress};

/// The result of a staged device transfer. `cancelled` is the authoritative cancel terminal - a
/// `PerformOperations` that returned `E_ABORT` because the sink aborted on the cancel flag, NOT
/// `GetAnyOperationsAborted` (proven unreliable on hardware; it tracks the shell's suppressed cancel
/// UI). The user-facing tally rides on the staging `ExportSummary`, so nothing else is carried here.
#[derive(Debug, Clone, Copy)]
pub struct TransferOutcome {
    pub cancelled: bool,
}

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

/// Transfers a staged export onto the device the PIDL names. Rebuilds the device `IShellItem` from
/// `pidl_hex`, then copies the staging root's TOP-LEVEL children onto it via the shell's
/// `IFileOperation`, streaming byte-driven `Transferring` progress through `emit` and aborting on
/// `cancel`. Returns a `TransferOutcome`; a failed rebuild or a non-abort operation error is an `Err`
/// (device disconnected / transfer failed). Windows-only; other platforms return an error. This runs
/// COM, so its caller must hold a `ComApartment` on the same STA thread.
#[cfg(windows)]
pub fn transfer_to_device(
    staging_root: &Path,
    pidl_hex: &str,
    cancel: &Arc<AtomicBool>,
    emit: impl Fn(ExportProgress) + Sync,
) -> Result<TransferOutcome, String> {
    win::transfer(staging_root, pidl_hex, cancel, emit)
}

/// A COM apartment tied to the thread that owns it: `CoInitializeEx(COINIT_APARTMENTTHREADED)` on
/// construction, `CoUninitialize` on drop. Held for the whole staging+transfer job on its dedicated
/// `std::thread` so apartment state can never leak onto a reused pool thread on an early return (the
/// device-unplugged path). The `windows` build initializes the STA; the stub is a no-op so the crate
/// stays cross-platform.
#[cfg(windows)]
pub use win::ComApartment;

#[cfg(not(windows))]
pub fn pick_device_folder() -> Result<Option<DeviceTarget>, String> {
    Err("device export is only available on Windows".to_string())
}

#[cfg(not(windows))]
pub fn device_reachable(_pidl_hex: &str) -> bool {
    false
}

#[cfg(not(windows))]
pub fn transfer_to_device(
    _staging_root: &Path,
    _pidl_hex: &str,
    _cancel: &Arc<AtomicBool>,
    _emit: impl Fn(ExportProgress) + Sync,
) -> Result<TransferOutcome, String> {
    Err("device export is only available on Windows".to_string())
}

/// The non-Windows stub of the COM apartment guard: nothing to initialize, so `new`/drop are no-ops.
/// It exists only so the device-export job code compiles on every platform; the actual transfer path
/// is Windows-gated and returns an error elsewhere.
#[cfg(not(windows))]
pub struct ComApartment;

#[cfg(not(windows))]
impl ComApartment {
    pub fn new() -> Self {
        ComApartment
    }
}

#[cfg(windows)]
mod win {
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use crate::dto::{DeviceTarget, ExportPhase, ExportProgress};
    use crate::scan::progress::ProgressThrottle;
    use super::TransferOutcome;
    use windows::core::{implement, Result, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{E_ABORT, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, FileOperation, IFileOpenDialog, IFileOperation, IFileOperationProgressSink,
        IFileOperationProgressSink_Impl, IShellItem, ILGetSize, SHCreateItemFromIDList,
        SHCreateItemFromParsingName, SHGetIDListFromObject, FOF_NOCONFIRMATION, FOF_NOERRORUI,
        FOF_SILENT, FOS_ALLNONSTORAGEITEMS, FOS_PICKFOLDERS, SIGDN, SIGDN_NORMALDISPLAY,
    };

    // The transfer progress cadence, matched to run_export's: sample faster than the emit interval so
    // a finished transfer is noticed quickly, and let the throttle coalesce the byte-progress wakeups
    // into steady ticks.
    const PROGRESS_POLL: Duration = Duration::from_millis(50);
    const PROGRESS_INTERVAL_MS: u64 = 100;

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

    // ---- staged transfer (P2) ----

    /// A COM apartment scoped to its owning thread (Trap B). Construction enters an STA; drop leaves
    /// it. `CoInitializeEx` may return `S_FALSE` (already initialized on this thread) - harmless, so
    /// its result is ignored like the spike's, since a fresh dedicated thread always gets `S_OK`.
    pub struct ComApartment;

    impl ComApartment {
        pub fn new() -> Self {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ComApartment
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    /// The state the progress sink shares with the transfer's emit loop. The sink writes the shell's
    /// byte-ish work counters and reads the cancel flag; the emit loop reads the counters. Interior
    /// mutability is all atomic, so the sink's `&self` callbacks need no lock.
    struct TransferShared {
        cancel: Arc<AtomicBool>,
        // iWorkTotal / iWorkSoFar from UpdateProgress: byte-ish units, so sidecars inflating the file
        // count never breaks the exported <= total invariant (Hole 2). Zero until the first update.
        total: AtomicU32,
        sofar: AtomicU32,
    }

    /// Ports the spike's proven transfer. Runs the COM copy on the calling (STA) thread while a
    /// scoped sibling thread streams byte-driven `Transferring` ticks, so the bar moves during the
    /// slow phase without the sink having to carry the emit closure. The caller owns the
    /// `ComApartment`.
    pub fn transfer(
        staging_root: &Path,
        pidl_hex: &str,
        cancel: &Arc<AtomicBool>,
        emit: impl Fn(ExportProgress) + Sync,
    ) -> std::result::Result<TransferOutcome, String> {
        let bytes = from_hex(pidl_hex).ok_or("the device is no longer connected")?;
        let shared = Arc::new(TransferShared {
            cancel: Arc::clone(cancel),
            total: AtomicU32::new(0),
            sofar: AtomicU32::new(0),
        });
        let done = AtomicBool::new(false);

        std::thread::scope(|s| -> std::result::Result<TransferOutcome, String> {
            // The emitter: throttled byte-progress ticks until the COM copy signals done, then one
            // final tick so the bar reads complete. Every tick stays `Transferring`/`done: false` -
            // the command owns the single real terminal `Done` after the transfer returns.
            let poll = {
                let shared = &shared;
                let done = &done;
                let emit = &emit;
                s.spawn(move || {
                    let start = Instant::now();
                    let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL_MS);
                    loop {
                        let is_done = done.load(Ordering::Relaxed);
                        let now_ms = start.elapsed().as_millis() as u64;
                        if throttle.should_emit(now_ms, is_done) {
                            emit(ExportProgress {
                                phase: ExportPhase::Transferring,
                                exported: shared.sofar.load(Ordering::Relaxed),
                                total: shared.total.load(Ordering::Relaxed),
                                errors: 0,
                                done: false,
                            });
                        }
                        if is_done {
                            break;
                        }
                        std::thread::sleep(PROGRESS_POLL);
                    }
                })
            };

            let result = unsafe { run_com(staging_root, &bytes, &shared) };
            done.store(true, Ordering::Relaxed);
            let _ = poll.join();
            result
        })
    }

    /// The COM half of the transfer: rebuild the device item, enqueue one `CopyItem` per top-level
    /// child of the staging root (Hole 1 - never the temp-named root itself), run the operation, and
    /// map its terminal. A sink-initiated `E_ABORT` is the authoritative cancel; any other error is a
    /// transfer failure. `SHCreateItemFromParsingName` over the staged children is sound because they
    /// are real filesystem paths, unlike the device item which only rebuilds from its PIDL.
    unsafe fn run_com(
        staging_root: &Path,
        pidl_bytes: &[u8],
        shared: &Arc<TransferShared>,
    ) -> std::result::Result<TransferOutcome, String> {
        // The durable device reference is the PIDL bytes, rebuilt in a 2-byte-aligned buffer. A
        // failure here is the disconnect path: the device the user picked is no longer reachable.
        let buf = aligned_pidl(pidl_bytes);
        let dest: IShellItem = SHCreateItemFromIDList(buf.as_ptr() as *const ITEMIDLIST)
            .map_err(|_| "the device is no longer connected".to_string())?;

        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|_| "could not start the device transfer".to_string())?;
        // Silent, unattended flags: no per-file confirmations, no shell error UI, no yes-to-all
        // prompts. Our own progress + cancel ride the sink instead.
        op.SetOperationFlags(FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI)
            .map_err(|_| "could not configure the device transfer".to_string())?;

        let sink: IFileOperationProgressSink = Sink {
            shared: Arc::clone(shared),
        }
        .into();
        let cookie = op
            .Advise(&sink)
            .map_err(|_| "could not attach transfer progress".to_string())?;

        // HOLE 1 FIX: one CopyItem per TOP-LEVEL child of the staging root, never the root itself -
        // else the phone nests the whole export under a temp-named folder. Folder creation on the
        // device is automatic (proven on hardware).
        let entries = std::fs::read_dir(staging_root)
            .map_err(|_| "could not read the staged export".to_string())?;
        for entry in entries {
            let child = entry
                .map_err(|_| "could not read the staged export".to_string())?
                .path();
            let wide: Vec<u16> = child
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let src: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(|_| "could not stage a file for transfer".to_string())?;
            op.CopyItem(&src, &dest, PCWSTR::null(), None)
                .map_err(|_| "could not queue a file for transfer".to_string())?;
        }

        let performed = op.PerformOperations();
        let _ = op.Unadvise(cookie);

        // The authoritative cancel terminal is PerformOperations' HRESULT == E_ABORT (the sink
        // returned it from PreCopyItem on the cancel flag). GetAnyOperationsAborted is NOT used - it
        // read false on a genuinely aborted hardware run, since FOF_SILENT suppresses the cancel UI
        // it actually tracks.
        match performed {
            Ok(()) => Ok(TransferOutcome { cancelled: false }),
            Err(e) if e.code() == E_ABORT => Ok(TransferOutcome { cancelled: true }),
            // Any other error is a real transfer failure - device unplugged mid-copy, out of space,
            // or a write refusal. MTP does not distinguish these reliably, so it stays generic.
            Err(_) => Err("the transfer to the device failed".to_string()),
        }
    }

    /// The IFileOperation progress sink. `&self` callbacks reach shared atomics only: `PreCopyItem`
    /// aborts the run when the cancel flag is set (returning `E_ABORT`, the one clean cancel path an
    /// `IFileOperation` offers), and `UpdateProgress` records the shell's byte-ish work counters for
    /// the emit loop to read. Every other callback is a no-op.
    #[implement(IFileOperationProgressSink)]
    struct Sink {
        shared: Arc<TransferShared>,
    }

    #[allow(non_snake_case)]
    impl IFileOperationProgressSink_Impl for Sink_Impl {
        fn StartOperations(&self) -> Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _hr: HRESULT) -> Result<()> {
            Ok(())
        }
        fn PreRenameItem(&self, _f: u32, _i: Option<&IShellItem>, _n: &PCWSTR) -> Result<()> {
            Ok(())
        }
        fn PostRenameItem(
            &self,
            _f: u32,
            _i: Option<&IShellItem>,
            _n: &PCWSTR,
            _hr: HRESULT,
            _c: Option<&IShellItem>,
        ) -> Result<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            _f: u32,
            _i: Option<&IShellItem>,
            _d: Option<&IShellItem>,
            _n: &PCWSTR,
        ) -> Result<()> {
            Ok(())
        }
        fn PostMoveItem(
            &self,
            _f: u32,
            _i: Option<&IShellItem>,
            _d: Option<&IShellItem>,
            _n: &PCWSTR,
            _hr: HRESULT,
            _c: Option<&IShellItem>,
        ) -> Result<()> {
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _f: u32,
            _i: Option<&IShellItem>,
            _d: Option<&IShellItem>,
            _n: &PCWSTR,
        ) -> Result<()> {
            // The cancel hook: a set flag aborts the operation after the current item, leaving a
            // partial copy on the device (no rollback - matches the design's honesty requirement).
            if self.shared.cancel.load(Ordering::Relaxed) {
                return Err(E_ABORT.into());
            }
            Ok(())
        }
        fn PostCopyItem(
            &self,
            _f: u32,
            _i: Option<&IShellItem>,
            _d: Option<&IShellItem>,
            _n: &PCWSTR,
            _hr: HRESULT,
            _c: Option<&IShellItem>,
        ) -> Result<()> {
            Ok(())
        }
        fn PreDeleteItem(&self, _f: u32, _i: Option<&IShellItem>) -> Result<()> {
            Ok(())
        }
        fn PostDeleteItem(
            &self,
            _f: u32,
            _i: Option<&IShellItem>,
            _hr: HRESULT,
            _c: Option<&IShellItem>,
        ) -> Result<()> {
            Ok(())
        }
        fn PreNewItem(&self, _f: u32, _d: Option<&IShellItem>, _n: &PCWSTR) -> Result<()> {
            Ok(())
        }
        fn PostNewItem(
            &self,
            _f: u32,
            _d: Option<&IShellItem>,
            _n: &PCWSTR,
            _tn: &PCWSTR,
            _attr: u32,
            _hr: HRESULT,
            _ni: Option<&IShellItem>,
        ) -> Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, total: u32, sofar: u32) -> Result<()> {
            // Byte-ish work units drive the determinate transfer bar (Hole 2): sofar <= total always,
            // so the emit loop never overshoots the way a sidecar-inflated file count would.
            self.shared.total.store(total, Ordering::Relaxed);
            self.shared.sofar.store(sofar, Ordering::Relaxed);
            Ok(())
        }
        fn ResetTimer(&self) -> Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> Result<()> {
            Ok(())
        }
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
