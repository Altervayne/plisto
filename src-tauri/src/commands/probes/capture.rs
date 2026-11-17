/*
 * Captures the main webview as a PNG through WebView2's CapturePreview and returns the bytes as a raw
 * IPC response. The stream is read on the UI thread, where its COM pointer lives; only the optional
 * save runs on the blocking pool. A save goes under the system temp folder, one folder per app run,
 * and stops at a fixed count of files.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::Response;
use tauri::webview::PlatformWebview;
use tauri::Webview;
use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
use windows62::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows62::Win32::UI::Shell::SHCreateMemStream;

// -- Local Imports --
use super::{blocking, hr, main_only, on_ui, Reply};

const MAX_SAVED: u32 = 64;
const FOLDER: &str = "plisto-probes";
const READ_CHUNK: usize = 64 * 1024;

static SAVED: AtomicU32 = AtomicU32::new(0);
static RUN: OnceLock<String> = OnceLock::new();

/// A PNG of the main webview. With `save`, also writes it to
/// `<temp>/plisto-probes/<run>/capture-<n>.png`; past the limit only the save is skipped.
#[tauri::command]
pub async fn probe_capture(save: bool, webview: Webview) -> Result<Response, String> {
    main_only(webview.label())?;
    // SAFETY: on_ui runs the closure on the UI thread with a live webview.
    let png = on_ui(&webview, |pw, reply| unsafe { request(pw, reply) }).await?;
    let png = if save {
        blocking(move || save_capture(&png).map(|()| png)).await?
    } else {
        png
    };
    Ok(Response::new(png))
}

unsafe fn request(pw: &PlatformWebview, reply: Reply<Vec<u8>>) -> Result<(), String> {
    let webview = pw.controller().CoreWebView2().map_err(hr)?;
    let stream = SHCreateMemStream(None).ok_or("no memory stream")?;
    let target = stream.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        reply.send(result.map_err(hr).and_then(|()| read_stream(&target)));
        Ok(())
    }));
    webview
        .CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
        .map_err(hr)
}

fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut chunk = vec![0u8; READ_CHUNK];
    // SAFETY: the stream is live and each read writes at most `chunk.len()` bytes into `chunk`.
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(hr)?;
        loop {
            let mut read = 0u32;
            stream
                .Read(
                    chunk.as_mut_ptr().cast(),
                    chunk.len() as u32,
                    Some(&mut read),
                )
                .ok()
                .map_err(hr)?;
            if read == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..read as usize]);
        }
    }
    Ok(out)
}

/// The next save number, counting from 1, or None once `MAX_SAVED` saves are taken. The counter
/// stops at the limit.
fn next_slot(counter: &AtomicU32) -> Option<u32> {
    counter
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_SAVED).then_some(n + 1)
        })
        .ok()
        .map(|n| n + 1)
}

/// Saves one capture. Past the limit the save is skipped with a line on stderr; the capture itself
/// still reaches the page.
fn save_capture(png: &[u8]) -> Result<(), String> {
    let Some(n) = next_slot(&SAVED) else {
        eprintln!("[probe] capture not saved: at most {MAX_SAVED} captures are saved per run");
        return Ok(());
    };
    let run = RUN.get_or_init(|| {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        format!("run-{ms}")
    });
    let path = capture_path(&std::env::temp_dir(), run, n).ok_or("capture number out of range")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, png).map_err(|e| e.to_string())
}

/// Where capture `n` of a run is saved, counting from 1, or None past the limit.
fn capture_path(temp: &Path, run: &str, n: u32) -> Option<PathBuf> {
    (1..=MAX_SAVED)
        .contains(&n)
        .then(|| temp.join(FOLDER).join(run).join(format!("capture-{n}.png")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_save_counter_stops_at_the_limit() {
        let counter = AtomicU32::new(0);
        let slots: Vec<u32> = (0..MAX_SAVED).filter_map(|_| next_slot(&counter)).collect();
        assert_eq!(slots, (1..=MAX_SAVED).collect::<Vec<u32>>());
        assert_eq!(next_slot(&counter), None);
        assert_eq!(next_slot(&counter), None);
        assert_eq!(counter.load(Ordering::SeqCst), MAX_SAVED);
    }

    #[test]
    fn captures_stay_in_the_run_folder_up_to_the_limit() {
        let temp = Path::new("T:/temp");
        assert_eq!(
            capture_path(temp, "run-1", 1).unwrap(),
            temp.join("plisto-probes")
                .join("run-1")
                .join("capture-1.png")
        );
        assert!(capture_path(temp, "run-1", MAX_SAVED).is_some());
        assert_eq!(capture_path(temp, "run-1", MAX_SAVED + 1), None);
        assert_eq!(capture_path(temp, "run-1", 0), None);
    }
}
