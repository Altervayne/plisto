/*
 * The WebView2 process commands: the process list, CPU and memory per process, ending a probe frame's
 * renderer, and ending the GPU process. Lists come from the main webview's environment on the UI
 * thread. Every command that acts on a pid opens its handle before checking the pid against a fresh
 * list: an open handle keeps the pid from being reused, so the check and the act name one process.
 *
 * A renderer may be ended only when the fresh list shows a main frame on the app's own origin, so the
 * main document's process is known, and the renderer is not that process, holds no main frame, and
 * either serves frames that are all on a probe host or serves none and was listed earlier, under the
 * same creation time, serving probe frames only. Any other process is refused.
 */

// -- Library Imports --
use std::ffi::c_void;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::webview::PlatformWebview;
use tauri::Webview;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment13, ICoreWebView2Environment8, ICoreWebView2FrameInfo2,
    ICoreWebView2FrameInfoCollection, ICoreWebView2ProcessExtendedInfoCollection,
    ICoreWebView2ProcessInfo, COREWEBVIEW2_FRAME_KIND, COREWEBVIEW2_FRAME_KIND_MAIN_FRAME,
    COREWEBVIEW2_PROCESS_KIND, COREWEBVIEW2_PROCESS_KIND_BROWSER, COREWEBVIEW2_PROCESS_KIND_GPU,
    COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER, COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN,
    COREWEBVIEW2_PROCESS_KIND_RENDERER, COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER,
    COREWEBVIEW2_PROCESS_KIND_UTILITY,
};
use webview2_com::{take_pwstr, GetProcessExtendedInfosCompletedHandler};
use windows::Win32::Foundation::{FILETIME, HANDLE};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_ACCESS_RIGHTS,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, PROCESS_VM_READ,
};
use windows62::core::{Interface, BOOL, PWSTR};

// -- Local Imports --
use super::{blocking, hr, main_only, on_ui, Reply};
use crate::plugins::frame_host::probe::parse_probe_url;

const MAX_PIDS: usize = 16;
const WINDOW_MS: (u64, u64) = (100, 5000);
const SEEN_CAP: usize = 256;
// The exit code a probe end leaves on the process.
const EXIT_CODE: u32 = 1;
// The origins the main window's own pages load from, in a dev run and in a built app.
const APP_ORIGINS: &[&str] = &["http://localhost:1420", "http://tauri.localhost"];

/// `(pid, creation time)` of every renderer listed while it served probe frames only.
static SEEN: Mutex<Vec<(u32, u64)>> = Mutex::new(Vec::new());
static GPU_CRASHES: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Browser,
    Renderer,
    Utility,
    SandboxHelper,
    Gpu,
    PpapiPlugin,
    PpapiBroker,
    Unknown,
}

impl Kind {
    fn from_raw(kind: COREWEBVIEW2_PROCESS_KIND) -> Self {
        match kind {
            COREWEBVIEW2_PROCESS_KIND_BROWSER => Kind::Browser,
            COREWEBVIEW2_PROCESS_KIND_RENDERER => Kind::Renderer,
            COREWEBVIEW2_PROCESS_KIND_UTILITY => Kind::Utility,
            COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER => Kind::SandboxHelper,
            COREWEBVIEW2_PROCESS_KIND_GPU => Kind::Gpu,
            COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN => Kind::PpapiPlugin,
            COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER => Kind::PpapiBroker,
            _ => Kind::Unknown,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Browser => "browser",
            Kind::Renderer => "renderer",
            Kind::Utility => "utility",
            Kind::SandboxHelper => "sandbox_helper",
            Kind::Gpu => "gpu",
            Kind::PpapiPlugin => "ppapi_plugin",
            Kind::PpapiBroker => "ppapi_broker",
            Kind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
struct Frame {
    source: String,
    main: bool,
}

/// One process as WebView2 lists it, with the frames it serves.
#[derive(Debug, Clone)]
struct Listed {
    pid: u32,
    kind: Kind,
    frames: Vec<Frame>,
}

impl Listed {
    /// A renderer serving at least one frame, every one of them on a probe host.
    fn probe_only(&self) -> bool {
        self.kind == Kind::Renderer
            && !self.frames.is_empty()
            && self
                .frames
                .iter()
                .all(|f| !f.main && parse_probe_url(&f.source).is_some())
    }
}

struct Listing {
    browser_version: String,
    processes: Vec<Listed>,
}

#[derive(Serialize)]
pub struct ProbeProcesses {
    browser_version: String,
    processes: Vec<ProcessView>,
}

#[derive(Serialize)]
pub struct ProcessView {
    pid: u32,
    kind: &'static str,
    hosts: Vec<String>,
}

#[derive(Serialize)]
pub struct CpuSample {
    pid: u32,
    percent_of_one_core: f64,
}

#[derive(Serialize)]
pub struct MemorySample {
    pid: u32,
    working_set: u64,
    private_bytes: u64,
}

/// The browser version and every WebView2 process with the scheme and host of each frame it serves.
/// Remembers each renderer serving probe frames only, so it can be ended later once frameless.
#[tauri::command]
pub async fn probe_processes(webview: Webview) -> Result<ProbeProcesses, String> {
    main_only(webview.label())?;
    let first = extended_list(&webview).await?;
    // Open each candidate before the list that confirms it, so a remembered creation time belongs to
    // the process that list describes. A renderer that cannot be opened is listed but not remembered.
    let opened: Vec<(u32, OwnedHandle, u64)> = first
        .processes
        .iter()
        .filter(|p| p.probe_only())
        .filter_map(|p| {
            let handle = open(p.pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
            let created = times(&handle).ok()?.created;
            Some((p.pid, handle, created))
        })
        .collect();
    let listing = extended_list(&webview).await?;
    let candidates: Vec<(u32, u64)> = opened.iter().map(|(pid, _, c)| (*pid, *c)).collect();
    {
        let mut seen = SEEN.lock().unwrap_or_else(PoisonError::into_inner);
        for entry in confirmed_seen(&listing.processes, &candidates) {
            remember(&mut seen, entry);
        }
    }
    drop(opened);
    Ok(ProbeProcesses {
        browser_version: listing.browser_version,
        processes: listing
            .processes
            .into_iter()
            .map(|p| ProcessView {
                pid: p.pid,
                kind: p.kind.name(),
                hosts: p.frames.iter().map(|f| scheme_host(&f.source)).collect(),
            })
            .collect(),
    })
}

/// The CPU each process used over the window, in percent of one core. A pid that cannot be read is
/// left out of the result.
#[tauri::command]
pub async fn probe_cpu(
    pids: Vec<u32>,
    window_ms: u64,
    webview: Webview,
) -> Result<Vec<CpuSample>, String> {
    main_only(webview.label())?;
    let handles = open_listed(
        &webview,
        clamp_pids(pids)?,
        PROCESS_QUERY_LIMITED_INFORMATION,
    )
    .await?;
    let window = clamp_window(window_ms);
    blocking(move || {
        let before = readable(
            handles
                .into_iter()
                .map(|(pid, h)| (pid, times(&h).map(|t| (h, t.cpu)))),
        );
        let start = Instant::now();
        thread::sleep(window);
        let wall = start.elapsed();
        let after = readable(before.into_iter().map(|(pid, (h, cpu_before))| {
            (pid, times(&h).map(|t| t.cpu.saturating_sub(cpu_before)))
        }));
        Ok(after
            .into_iter()
            .map(|(pid, used)| CpuSample {
                pid,
                percent_of_one_core: percent_of_one_core(used, wall),
            })
            .collect())
    })
    .await
}

/// The working set and private bytes of each process. A pid that cannot be read is left out of the
/// result.
#[tauri::command]
pub async fn probe_memory(pids: Vec<u32>, webview: Webview) -> Result<Vec<MemorySample>, String> {
    main_only(webview.label())?;
    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ;
    let handles = open_listed(&webview, clamp_pids(pids)?, access).await?;
    blocking(move || {
        let read = readable(handles.into_iter().map(|(pid, h)| (pid, memory(&h))));
        Ok(read
            .into_iter()
            .map(|(pid, (working_set, private_bytes))| MemorySample {
                pid,
                working_set,
                private_bytes,
            })
            .collect())
    })
    .await
}

/// Ends one probe frame's renderer. Refuses any other process.
#[tauri::command]
pub async fn probe_terminate(pid: u32, webview: Webview) -> Result<(), String> {
    main_only(webview.label())?;
    let handle = open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)?;
    let created = times(&handle)?.created;
    let listing = extended_list(&webview).await?;
    let seen = SEEN.lock().unwrap_or_else(PoisonError::into_inner).clone();
    terminate_allowed(&listing.processes, &seen, pid, created)
        .map_err(|why| format!("pid {pid} refused: {why}"))?;
    end(&handle, pid)
}

/// Ends the WebView2 GPU process and returns its pid. Prints each end to the terminal, since the
/// page may not survive to record it.
#[tauri::command]
pub async fn probe_gpu_crash(webview: Webview) -> Result<u32, String> {
    main_only(webview.label())?;
    let pid = sole_gpu(&kind_list(&webview).await?).ok_or("no single GPU process is listed")?;
    let handle = open(pid, PROCESS_TERMINATE)?;
    if !is_gpu(&kind_list(&webview).await?, pid) {
        return Err(format!("pid {pid} is no longer the GPU process"));
    }
    end(&handle, pid)?;
    let n = GPU_CRASHES.fetch_add(1, Ordering::SeqCst) + 1;
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    eprintln!("[probe] gpu crash {n} pid {pid} at {at} ms since the Unix epoch");
    Ok(pid)
}

// ---- Guards ----

/// Whether `pid`, whose open handle reports `created`, may be ended, judged on a fresh list.
fn terminate_allowed(
    list: &[Listed],
    seen: &[(u32, u64)],
    pid: u32,
    created: u64,
) -> Result<(), &'static str> {
    let documents = main_document_pids(list);
    if documents.is_empty() {
        return Err("no main frame on the app origin is listed, so its process is unknown");
    }
    if documents.contains(&pid) {
        return Err("serves the main document");
    }
    let process = list
        .iter()
        .find(|p| p.pid == pid)
        .ok_or("not a WebView2 process")?;
    if process.kind != Kind::Renderer {
        return Err("not a renderer");
    }
    if process.frames.iter().any(|f| f.main) {
        return Err("serves a main frame");
    }
    if process.frames.is_empty() {
        return if seen.contains(&(pid, created)) {
            Ok(())
        } else {
            Err("frameless and never seen serving probe frames only")
        };
    }
    if process.probe_only() {
        Ok(())
    } else {
        Err("serves a frame outside the probe hosts")
    }
}

/// The pids of the processes listed as serving a main frame on the app's own origin.
fn main_document_pids(list: &[Listed]) -> Vec<u32> {
    list.iter()
        .filter(|p| {
            p.frames
                .iter()
                .any(|f| f.main && APP_ORIGINS.contains(&origin_of(&f.source)))
        })
        .map(|p| p.pid)
        .collect()
}

/// The `scheme://authority` prefix of an absolute URL, or the whole string when it has none.
fn origin_of(url: &str) -> &str {
    let Some(start) = url.find("://").map(|i| i + 3) else {
        return url;
    };
    let end = url[start..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |i| start + i);
    &url[..end]
}

/// The opened candidates the fresh list still shows serving probe frames only.
fn confirmed_seen(fresh: &[Listed], opened: &[(u32, u64)]) -> Vec<(u32, u64)> {
    opened
        .iter()
        .filter(|(pid, _)| fresh.iter().any(|p| p.pid == *pid && p.probe_only()))
        .copied()
        .collect()
}

/// The readings that succeeded, in order; a pid whose reading failed is dropped.
fn readable<T, E>(readings: impl IntoIterator<Item = (u32, Result<T, E>)>) -> Vec<(u32, T)> {
    readings
        .into_iter()
        .filter_map(|(pid, reading)| reading.ok().map(|value| (pid, value)))
        .collect()
}

/// Refuses the call when any requested pid is missing from the WebView2 list.
fn check_listed(pids: &[u32], list: &[(u32, Kind)]) -> Result<(), String> {
    match pids.iter().find(|pid| !list.iter().any(|(p, _)| p == *pid)) {
        Some(pid) => Err(format!("pid {pid} is not a WebView2 process")),
        None => Ok(()),
    }
}

/// The GPU process's pid when exactly one is listed.
fn sole_gpu(list: &[(u32, Kind)]) -> Option<u32> {
    let mut gpus = list.iter().filter(|(_, kind)| *kind == Kind::Gpu);
    match (gpus.next(), gpus.next()) {
        (Some((pid, _)), None) => Some(*pid),
        _ => None,
    }
}

fn is_gpu(list: &[(u32, Kind)], pid: u32) -> bool {
    list.iter().any(|(p, kind)| *p == pid && *kind == Kind::Gpu)
}

/// Distinct pids in request order, at least one and at most `MAX_PIDS`.
fn clamp_pids(pids: Vec<u32>) -> Result<Vec<u32>, String> {
    let mut out = Vec::new();
    for pid in pids {
        if !out.contains(&pid) {
            out.push(pid);
        }
    }
    out.truncate(MAX_PIDS);
    if out.is_empty() {
        Err("no pid given".to_string())
    } else {
        Ok(out)
    }
}

fn remember(seen: &mut Vec<(u32, u64)>, entry: (u32, u64)) {
    if seen.contains(&entry) {
        return;
    }
    if seen.len() == SEEN_CAP {
        seen.remove(0);
    }
    seen.push(entry);
}

/// The scheme and host of a frame URL, without userinfo, port, path, query or fragment. A URL
/// without an authority keeps its scheme only, as `about:`.
fn scheme_host(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url
            .split_once(':')
            .map_or_else(String::new, |(scheme, _)| format!("{scheme}:"));
    };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6
            .split_once(']')
            .map_or(host, |(addr, _)| &host[..addr.len() + 2]),
        None => host.split_once(':').map_or(host, |(name, _)| name),
    };
    format!("{scheme}://{host}")
}

fn clamp_window(window_ms: u64) -> Duration {
    Duration::from_millis(window_ms.clamp(WINDOW_MS.0, WINDOW_MS.1))
}

/// CPU time in 100 ns units, used over a wall interval, as percent of one core.
fn percent_of_one_core(cpu_100ns: u64, wall: Duration) -> f64 {
    if wall.is_zero() {
        return 0.0;
    }
    cpu_100ns as f64 * 100.0 / (wall.as_nanos() as f64 / 100.0)
}

// ---- WebView2 lists ----

async fn extended_list(webview: &Webview) -> Result<Listing, String> {
    // SAFETY: on_ui runs the closure on the UI thread with a live webview.
    on_ui(webview, |pw, reply| unsafe { request_extended(pw, reply) }).await
}

async fn kind_list(webview: &Webview) -> Result<Vec<(u32, Kind)>, String> {
    on_ui(webview, |pw, reply| {
        // SAFETY: called on the UI thread with a live webview.
        reply.send(unsafe { process_kinds(pw) });
        Ok(())
    })
    .await
}

unsafe fn request_extended(pw: &PlatformWebview, reply: Reply<Listing>) -> Result<(), String> {
    let env = pw.environment();
    let mut version = PWSTR::null();
    env.BrowserVersionString(&mut version).map_err(hr)?;
    let browser_version = take_pwstr(version);
    let env = env.cast::<ICoreWebView2Environment13>().map_err(hr)?;
    let handler =
        GetProcessExtendedInfosCompletedHandler::create(Box::new(move |result, infos| {
            let listed = result.map_err(hr).and_then(|()| read_extended(infos));
            reply.send(listed.map(|processes| Listing {
                browser_version,
                processes,
            }));
            Ok(())
        }));
    env.GetProcessExtendedInfos(&handler).map_err(hr)
}

unsafe fn read_extended(
    infos: Option<ICoreWebView2ProcessExtendedInfoCollection>,
) -> Result<Vec<Listed>, String> {
    let infos = infos.ok_or("WebView2 returned no process list")?;
    let mut count = 0;
    infos.Count(&mut count).map_err(hr)?;
    let mut out = Vec::new();
    for i in 0..count {
        let info = infos.GetValueAtIndex(i).map_err(hr)?;
        let (pid, kind) = pid_kind(&info.ProcessInfo().map_err(hr)?)?;
        let frames = read_frames(&info.AssociatedFrameInfos().map_err(hr)?)?;
        out.push(Listed { pid, kind, frames });
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

unsafe fn process_kinds(pw: &PlatformWebview) -> Result<Vec<(u32, Kind)>, String> {
    let env = pw
        .environment()
        .cast::<ICoreWebView2Environment8>()
        .map_err(hr)?;
    let infos = env.GetProcessInfos().map_err(hr)?;
    let mut count = 0;
    infos.Count(&mut count).map_err(hr)?;
    (0..count)
        .map(|i| pid_kind(&infos.GetValueAtIndex(i).map_err(hr)?))
        .collect()
}

unsafe fn pid_kind(process: &ICoreWebView2ProcessInfo) -> Result<(u32, Kind), String> {
    let mut pid = 0i32;
    process.ProcessId(&mut pid).map_err(hr)?;
    let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
    process.Kind(&mut kind).map_err(hr)?;
    let pid = u32::try_from(pid).map_err(|_| format!("negative pid {pid}"))?;
    Ok((pid, Kind::from_raw(kind)))
}

// ---- Process handles ----

struct Times {
    created: u64,
    cpu: u64,
}

fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Result<OwnedHandle, String> {
    // SAFETY: OpenProcess returns a fresh handle, owned from here on and closed on drop.
    unsafe {
        let handle = OpenProcess(access, false, pid).map_err(|e| format!("pid {pid}: {e}"))?;
        Ok(OwnedHandle::from_raw_handle(handle.0))
    }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

/// Opens each pid, then refuses the call unless a fresh WebView2 list holds every one. Returns the
/// handles that opened; a pid that could not be opened is left out.
async fn open_listed(
    webview: &Webview,
    pids: Vec<u32>,
    access: PROCESS_ACCESS_RIGHTS,
) -> Result<Vec<(u32, OwnedHandle)>, String> {
    let opened: Vec<(u32, Result<OwnedHandle, String>)> =
        pids.iter().map(|&pid| (pid, open(pid, access))).collect();
    check_listed(&pids, &kind_list(webview).await?)?;
    Ok(readable(opened))
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

fn end(handle: &OwnedHandle, pid: u32) -> Result<(), String> {
    // SAFETY: the handle is open with terminate rights.
    unsafe { TerminateProcess(raw(handle), EXIT_CODE) }.map_err(|e| format!("pid {pid}: {e}"))
}

// PROCESS_MEMORY_COUNTERS_EX from psapi.h.
#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCountersEx {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
}

#[cfg(all(windows, debug_assertions))]
#[link(name = "kernel32")]
extern "system" {
    fn K32GetProcessMemoryInfo(
        process: *mut c_void,
        counters: *mut ProcessMemoryCountersEx,
        cb: u32,
    ) -> i32;
}

/// Working set and private bytes.
fn memory(handle: &OwnedHandle) -> Result<(u64, u64), String> {
    let mut counters = ProcessMemoryCountersEx {
        cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
        ..Default::default()
    };
    let cb = counters.cb;
    // SAFETY: the handle is open and `counters` is a live struct of the size passed.
    let ok = unsafe { K32GetProcessMemoryInfo(handle.as_raw_handle(), &mut counters, cb) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok((
        counters.working_set_size as u64,
        counters.private_usage as u64,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE: &str = "https://probe-vis.invalid/vis-busy.html";
    const PROBE_UI: &str = "https://probe-ui1.invalid/page-heartbeat.html";
    const APP: &str = "http://localhost:1420/";
    const PLUGIN: &str = "https://pp-0123456789abcdef0123456789abcdef.invalid/index.html";

    fn frame(source: &str, main: bool) -> Frame {
        Frame {
            source: source.to_string(),
            main,
        }
    }

    fn process(pid: u32, kind: Kind, frames: Vec<Frame>) -> Listed {
        Listed { pid, kind, frames }
    }

    fn list() -> Vec<Listed> {
        vec![
            process(1, Kind::Browser, vec![]),
            process(2, Kind::Gpu, vec![]),
            process(3, Kind::Utility, vec![]),
            process(4, Kind::Renderer, vec![frame(APP, true)]),
            process(
                5,
                Kind::Renderer,
                vec![frame(PROBE, false), frame(PROBE, false)],
            ),
            process(
                6,
                Kind::Renderer,
                vec![frame(PROBE, false), frame(PLUGIN, false)],
            ),
            process(7, Kind::Renderer, vec![]),
            process(8, Kind::Renderer, vec![frame(PROBE_UI, false)]),
            process(
                9,
                Kind::Renderer,
                vec![frame(APP, true), frame(PROBE, false)],
            ),
            process(10, Kind::Renderer, vec![frame(PROBE, true)]),
        ]
    }

    #[test]
    fn terminate_accepts_probe_only_renderers() {
        let list = list();
        assert_eq!(terminate_allowed(&list, &[], 5, 50), Ok(()));
        assert_eq!(terminate_allowed(&list, &[], 8, 80), Ok(()));
    }

    #[test]
    fn terminate_accepts_a_seen_frameless_renderer_only_under_its_creation_time() {
        let list = list();
        assert_eq!(terminate_allowed(&list, &[(7, 70)], 7, 70), Ok(()));
        assert!(terminate_allowed(&list, &[(7, 70)], 7, 71).is_err());
        assert!(terminate_allowed(&list, &[(8, 70)], 7, 70).is_err());
        assert!(terminate_allowed(&list, &[], 7, 70).is_err());
    }

    #[test]
    fn terminate_refuses_every_other_process() {
        let list = list();
        let seen: Vec<(u32, u64)> = (1..=11).map(|pid| (pid, 0)).collect();
        // Browser, GPU, utility, the main document, a mixed renderer, the main document hosting
        // a probe frame, a main frame on a probe host, an unknown pid.
        for pid in [1, 2, 3, 4, 6, 9, 10, 11] {
            assert!(
                terminate_allowed(&list, &seen, pid, 0).is_err(),
                "pid {pid}"
            );
        }
    }

    #[test]
    fn the_gpu_guard_accepts_the_gpu_process_only() {
        let kinds: Vec<(u32, Kind)> = list().iter().map(|p| (p.pid, p.kind)).collect();
        assert_eq!(sole_gpu(&kinds), Some(2));
        assert!(is_gpu(&kinds, 2));
        for pid in [1, 3, 4, 5, 99] {
            assert!(!is_gpu(&kinds, pid), "pid {pid}");
        }
        assert_eq!(sole_gpu(&[(1, Kind::Browser)]), None);
        assert_eq!(sole_gpu(&[(2, Kind::Gpu), (12, Kind::Gpu)]), None);
    }

    #[test]
    fn pids_are_distinct_bounded_and_never_empty() {
        assert!(clamp_pids(vec![]).is_err());
        assert_eq!(clamp_pids(vec![4, 4, 5]).unwrap(), [4, 5]);
        let many = clamp_pids((1..=40).collect()).unwrap();
        assert_eq!(many, (1..=16).collect::<Vec<u32>>());
    }

    #[test]
    fn the_sampling_window_is_clamped() {
        assert_eq!(clamp_window(0), Duration::from_millis(100));
        assert_eq!(clamp_window(250), Duration::from_millis(250));
        assert_eq!(clamp_window(60_000), Duration::from_millis(5000));
    }

    #[test]
    fn the_seen_set_is_bounded_and_distinct() {
        let mut seen = Vec::new();
        remember(&mut seen, (1, 1));
        remember(&mut seen, (1, 1));
        assert_eq!(seen.len(), 1);
        for pid in 2..=(SEEN_CAP as u32 + 1) {
            remember(&mut seen, (pid, 0));
        }
        assert_eq!(seen.len(), SEEN_CAP);
        assert!(!seen.contains(&(1, 1)));
    }

    #[test]
    fn frame_urls_reduce_to_scheme_and_host() {
        for (url, host) in [
            (PROBE, "https://probe-vis.invalid"),
            ("http://localhost:1420/?window=probes#x", "http://localhost"),
            (
                "https://user:secret@probe-ui1.invalid/a",
                "https://probe-ui1.invalid",
            ),
            ("https://probe-ui1.invalid?q=1", "https://probe-ui1.invalid"),
            ("http://[::1]:8080/x", "http://[::1]"),
            ("about:blank", "about:"),
            ("data:text/html,<b>secret</b>", "data:"),
            ("", ""),
        ] {
            assert_eq!(scheme_host(url), host, "{url}");
        }
    }

    #[test]
    fn cpu_percent_is_per_core() {
        let second = Duration::from_secs(1);
        assert_eq!(percent_of_one_core(10_000_000, second), 100.0);
        assert_eq!(percent_of_one_core(5_000_000, second), 50.0);
        assert_eq!(percent_of_one_core(20_000_000, second), 200.0);
        assert_eq!(percent_of_one_core(1, Duration::ZERO), 0.0);
    }

    #[test]
    fn the_memory_struct_matches_the_psapi_layout() {
        use std::mem::{offset_of, size_of};
        type C = ProcessMemoryCountersEx;
        let word = size_of::<usize>();
        assert_eq!(offset_of!(C, cb), 0);
        assert_eq!(offset_of!(C, page_fault_count), 4);
        let words = [
            offset_of!(C, peak_working_set_size),
            offset_of!(C, working_set_size),
            offset_of!(C, quota_peak_paged_pool_usage),
            offset_of!(C, quota_paged_pool_usage),
            offset_of!(C, quota_peak_non_paged_pool_usage),
            offset_of!(C, quota_non_paged_pool_usage),
            offset_of!(C, pagefile_usage),
            offset_of!(C, peak_pagefile_usage),
            offset_of!(C, private_usage),
        ];
        for (i, offset) in words.into_iter().enumerate() {
            assert_eq!(offset, 8 + i * word, "word field {i}");
        }
        assert_eq!(size_of::<C>(), 8 + 9 * word);
    }

    #[test]
    fn terminate_needs_a_listed_main_frame_on_the_app_origin() {
        let probe = process(5, Kind::Renderer, vec![frame(PROBE, false)]);
        assert!(terminate_allowed(&[probe.clone()], &[], 5, 0).is_err());
        // A main frame on a probe host is no proof of where the main document lives.
        let fake = process(10, Kind::Renderer, vec![frame(PROBE, true)]);
        assert!(terminate_allowed(&[probe.clone(), fake], &[], 5, 0).is_err());
        let page = process(4, Kind::Renderer, vec![frame(APP, true)]);
        assert_eq!(terminate_allowed(&[probe, page], &[], 5, 0), Ok(()));
    }

    #[test]
    fn terminate_refuses_a_probe_frame_beside_an_unhosted_frame() {
        for other in ["about:blank", ""] {
            let mut list = list();
            list.push(process(
                20,
                Kind::Renderer,
                vec![frame(PROBE, false), frame(other, false)],
            ));
            assert!(terminate_allowed(&list, &[], 20, 0).is_err(), "{other:?}");
        }
    }

    #[test]
    fn an_unflagged_main_frame_is_caught_by_its_host() {
        // The frame kind could not be read, so the page's own frame arrives without the main flag.
        let mut list = list();
        list.push(process(
            21,
            Kind::Renderer,
            vec![frame(APP, false), frame(PROBE, false)],
        ));
        assert!(terminate_allowed(&list, &[], 21, 0).is_err());
    }

    #[test]
    fn only_candidates_the_fresh_list_confirms_are_remembered() {
        let fresh = list();
        // 5 is still probe-only; 6 now serves a plugin frame; 30 is gone; 7 is frameless.
        let opened = [(5, 50), (6, 60), (30, 300), (7, 70)];
        assert_eq!(confirmed_seen(&fresh, &opened), [(5, 50)]);
    }

    #[test]
    fn unreadable_pids_are_left_out_and_unlisted_pids_refuse_the_call() {
        let readings = vec![(1, Ok(10)), (2, Err("denied")), (3, Ok(30))];
        assert_eq!(readable(readings), [(1, 10), (3, 30)]);
        let kinds = [(1, Kind::Renderer), (2, Kind::Renderer)];
        assert!(check_listed(&[1, 2], &kinds).is_ok());
        assert!(check_listed(&[1, 3], &kinds).is_err());
    }

    #[test]
    fn origins_cut_at_the_path() {
        assert_eq!(
            origin_of("http://localhost:1420/?window=probes"),
            "http://localhost:1420"
        );
        assert_eq!(
            origin_of("http://tauri.localhost"),
            "http://tauri.localhost"
        );
        assert_eq!(origin_of("about:blank"), "about:blank");
    }
}
