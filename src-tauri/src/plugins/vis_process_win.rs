/*
 * The visualizer process watch's Windows side: lists the main webview's WebView2 processes, holds a
 * handle to each renderer serving visualizer frames, samples its CPU once a second, and ends one
 * that `vis_process` gives up on. Lists are read on the UI thread; the sampling and the waits run
 * on the watch's own thread.
 *
 * The thread starts when a visualizer host request or a shown visualizer wakes it, and stops after
 * a few ticks with nothing tracked and no visualizer frame listed, releasing every handle. A panic
 * in it clears the running flag, so the next wake starts a new one.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::{mpsc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::PlatformWebview;
use tauri::{AppHandle, Manager, Runtime};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment13, ICoreWebView2FrameInfo2, ICoreWebView2FrameInfoCollection,
    ICoreWebView2ProcessExtendedInfoCollection, COREWEBVIEW2_FRAME_KIND,
    COREWEBVIEW2_FRAME_KIND_MAIN_FRAME, COREWEBVIEW2_PROCESS_KIND,
    COREWEBVIEW2_PROCESS_KIND_RENDERER,
};
use webview2_com::{take_pwstr, GetProcessExtendedInfosCompletedHandler};
use windows::Win32::Foundation::{FILETIME, HANDLE};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};
use windows62::core::{Interface, BOOL, PWSTR};

// -- Local Imports --
use super::vis_process::{idle_after, Frame, Listed, Shown, Watch, IDLE_TICKS};

const MAIN_LABEL: &str = "main";
const TICK: Duration = Duration::from_secs(1);
const LIST_WAIT: Duration = Duration::from_secs(5);
// The exit code an ended visualizer process is left with.
const EXIT_CODE: u32 = 1;

struct Run {
    running: bool,
    woken: bool,
}

static RUN: Mutex<Run> = Mutex::new(Run {
    running: false,
    woken: false,
});
static SHOWN: Mutex<Shown> = Mutex::new(Shown::new());

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Starts the watch thread unless it runs, and keeps a running one from stopping on its next
/// idle check.
pub fn wake<R: Runtime>(app: &AppHandle<R>) {
    let mut run = locked(&RUN);
    run.woken = true;
    if run.running {
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("plugin-vis-watch".into())
        .spawn(move || watch_loop(app));
    match spawned {
        Ok(_) => run.running = true,
        Err(e) => eprintln!("plugins: no visualizer process watch thread: {e}"),
    }
}

/// Replaces the set of shown visualizer host labels with a valid report. A non-empty set wakes the
/// watch.
pub fn set_shown<R: Runtime>(app: &AppHandle<R>, labels: BTreeSet<String>) {
    let any = !labels.is_empty();
    locked(&SHOWN).report(labels);
    if any {
        wake(app);
    }
}

/// Marks the shown set unknown after a rejected report; nothing is ended until a valid one.
pub fn reject_shown() {
    locked(&SHOWN).reject();
}

/// Clears the running flag when the watch thread unwinds from a panic. A normal stop clears it
/// under the lock instead, before a later wake may start a new thread.
struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        if thread::panicking() {
            locked(&RUN).running = false;
        }
    }
}

fn watch_loop<R: Runtime>(app: AppHandle<R>) {
    let _running = Running;
    let mut watch: Watch<OwnedHandle> = Watch::default();
    let mut idle = 0;
    loop {
        // An unreadable list skips the tick: nothing is sampled, ended or dropped.
        let empty = list(&app).ok().map(|listed| {
            tick(&app, &mut watch, &listed);
            watch.idle(&listed)
        });
        let woken = std::mem::take(&mut locked(&RUN).woken);
        idle = idle_after(idle, woken, empty, watch.is_tracking());
        if idle >= IDLE_TICKS {
            let mut run = locked(&RUN);
            if !run.woken {
                run.running = false;
                return;
            }
        }
        thread::sleep(TICK);
    }
}

/// Applies one list: samples the confirmed renderers, ends the due ones the guard allows, and opens
/// the renderers newly listed serving visualizer frames only, for the next list to confirm.
fn tick<R: Runtime>(app: &AppHandle<R>, watch: &mut Watch<OwnedHandle>, listed: &[Listed]) {
    let fresh = watch.apply(listed);
    let shown = locked(&SHOWN).take_interval();
    let due = watch.sample(Instant::now(), &shown, |h| times(h).ok().map(|t| t.cpu));
    for pid in due {
        end_checked(app, watch, pid);
    }
    for pid in fresh {
        let Ok(handle) = open(pid) else {
            continue;
        };
        if let Ok(t) = times(&handle) {
            let reports = locked(&SHOWN).reports();
            watch.add(pid, t.created, handle, reports);
        }
    }
}

/// Ends a due renderer through its tracked handle once a list taken now allows it. The shown set
/// stays locked from its last read through the end, so no report lands in between.
fn end_checked<R: Runtime>(app: &AppHandle<R>, watch: &Watch<OwnedHandle>, pid: u32) {
    let ended = list(app).and_then(|fresh| {
        let shown = locked(&SHOWN);
        let handle = watch
            .end_check(pid, &fresh, &shown.peek())
            .map_err(|refusal| refusal.reason().to_string())?;
        end(handle)
    });
    match ended {
        Ok(()) => eprintln!(
            "plugins: ended visualizer process {pid}, busy on one core with none of its \
             visualizers shown"
        ),
        Err(why) => eprintln!("plugins: kept visualizer process {pid}: {why}"),
    }
}

// ---- WebView2 list ----

/// A COM error with its HRESULT, which tells a missing interface from a failed call.
fn hr(e: windows62::core::Error) -> String {
    format!("{:#010X} {}", e.code().0, e.message())
}

/// Every WebView2 process of the main webview's environment, with the frames it serves.
fn list<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Listed>, String> {
    let main = app.get_webview_window(MAIN_LABEL).ok_or("no main window")?;
    let (tx, rx) = mpsc::channel();
    main.with_webview(move |pw| {
        // SAFETY: with_webview runs this on the UI thread with a live webview.
        if let Err(e) = unsafe { request(&pw, tx.clone()) } {
            let _ = tx.send(Err(e));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(LIST_WAIT)
        .map_err(|_| "the webview did not answer the process list".to_string())?
}

type ListReply = mpsc::Sender<Result<Vec<Listed>, String>>;

unsafe fn request(pw: &PlatformWebview, reply: ListReply) -> Result<(), String> {
    let env = pw
        .environment()
        .cast::<ICoreWebView2Environment13>()
        .map_err(hr)?;
    let handler =
        GetProcessExtendedInfosCompletedHandler::create(Box::new(move |result, infos| {
            let _ = reply.send(result.map_err(hr).and_then(|()| read_list(infos)));
            Ok(())
        }));
    env.GetProcessExtendedInfos(&handler).map_err(hr)
}

unsafe fn read_list(
    infos: Option<ICoreWebView2ProcessExtendedInfoCollection>,
) -> Result<Vec<Listed>, String> {
    let infos = infos.ok_or("WebView2 returned no process list")?;
    let mut count = 0;
    infos.Count(&mut count).map_err(hr)?;
    let mut out = Vec::new();
    for i in 0..count {
        let info = infos.GetValueAtIndex(i).map_err(hr)?;
        let process = info.ProcessInfo().map_err(hr)?;
        let mut pid = 0i32;
        process.ProcessId(&mut pid).map_err(hr)?;
        let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
        process.Kind(&mut kind).map_err(hr)?;
        let pid = u32::try_from(pid).map_err(|_| format!("negative pid {pid}"))?;
        let frames = read_frames(&info.AssociatedFrameInfos().map_err(hr)?)?;
        out.push(Listed {
            pid,
            renderer: kind == COREWEBVIEW2_PROCESS_KIND_RENDERER,
            frames,
        });
    }
    Ok(out)
}

unsafe fn read_frames(frames: &ICoreWebView2FrameInfoCollection) -> Result<Vec<Frame>, String> {
    let iter = frames.GetIterator().map_err(hr)?;
    let mut out = Vec::new();
    loop {
        let mut has = BOOL::default();
        iter.HasCurrent(&mut has).map_err(hr)?;
        if !has.as_bool() {
            break;
        }
        let frame = iter.GetCurrent().map_err(hr)?;
        let mut source = PWSTR::null();
        frame.Source(&mut source).map_err(hr)?;
        // An unreadable kind leaves the frame unflagged; the guard still knows the app's own
        // frames by their host.
        let mut kind = COREWEBVIEW2_FRAME_KIND::default();
        let main = frame
            .cast::<ICoreWebView2FrameInfo2>()
            .and_then(|f| f.FrameKind(&mut kind))
            .is_ok()
            && kind == COREWEBVIEW2_FRAME_KIND_MAIN_FRAME;
        out.push(Frame {
            source: take_pwstr(source),
            main,
        });
        let mut next = BOOL::default();
        iter.MoveNext(&mut next).map_err(hr)?;
    }
    Ok(out)
}

// ---- Process handles ----

struct Times {
    created: u64,
    cpu: u64,
}

/// A handle that may read times and end the process. While it is open the pid cannot be reused.
fn open(pid: u32) -> Result<OwnedHandle, String> {
    let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
    // SAFETY: OpenProcess returns a fresh handle, owned from here on and closed on drop.
    unsafe {
        let handle = OpenProcess(access, false, pid).map_err(|e| format!("pid {pid}: {e}"))?;
        Ok(OwnedHandle::from_raw_handle(handle.0))
    }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

fn times(handle: &OwnedHandle) -> Result<Times, String> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the handle is open and every pointer is a live local.
    unsafe {
        GetProcessTimes(
            raw(handle),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(Times {
        created: ticks(created),
        cpu: ticks(kernel) + ticks(user),
    })
}

fn end(handle: &OwnedHandle) -> Result<(), String> {
    // SAFETY: the handle is open with terminate rights.
    unsafe { TerminateProcess(raw(handle), EXIT_CODE) }.map_err(|e| e.to_string())
}
