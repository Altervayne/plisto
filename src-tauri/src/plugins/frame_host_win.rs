/*
 * The frame host's WebView2 side: a WebResourceRequested handler on the main webview that answers
 * requests for the plugin frame host from the plugin folders. wry's own handler receives the same
 * events, so a URI the frame host does not own is left untouched: no response and no deferral. COM
 * pointers are not Send, so the pending requests stay in a map on the UI thread while the disk work
 * runs on the blocking pool, and the answer is completed back on the UI thread.
 */

// -- Library Imports --
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::http::{Response, StatusCode};
use tauri::webview::PlatformWebview;
use tauri::{AppHandle, Runtime};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Deferral, ICoreWebView2Environment, ICoreWebView2WebResourceRequest,
    ICoreWebView2WebResourceRequestedEventArgs, ICoreWebView2_22,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
};
use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
use windows62::core::{Interface, Result, HSTRING, PWSTR};
use windows62::Win32::UI::Shell::SHCreateMemStream;

// -- Local Imports --
use super::frame_host::{self, ResourceKind};

struct Pending {
    args: ICoreWebView2WebResourceRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    env: ICoreWebView2Environment,
}

thread_local! {
    static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::new(HashMap::new());
}

static NEXT_KEY: AtomicU64 = AtomicU64::new(0);

/// Hands a response back to the UI thread when dropped. A task that panics before setting one still
/// completes the request, with a 500, so the frame never hangs on its load.
struct Finish<R: Runtime> {
    key: u64,
    app: AppHandle<R>,
    response: Option<Response<Vec<u8>>>,
}

impl<R: Runtime> Drop for Finish<R> {
    fn drop(&mut self) {
        let key = self.key;
        let response = self
            .response
            .take()
            .unwrap_or_else(|| frame_host::refusal(StatusCode::INTERNAL_SERVER_ERROR));
        let _ = self.app.run_on_main_thread(move || complete(key, response));
    }
}

/// Registers the frame host on one webview. Errors when the runtime lacks `ICoreWebView2_22`, the
/// interface that lets the filter match requests from child frames.
pub fn install<R: Runtime>(
    pw: &PlatformWebview,
    app: AppHandle<R>,
    app_data: PathBuf,
) -> Result<()> {
    let env = pw.environment();
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            // SAFETY: called by WebView2 on the UI thread with live event args.
            unsafe { on_request(&app, &app_data, &env, args) };
        }
        Ok(())
    }));
    // SAFETY: the controller and its webview are live for the duration of `with_webview`.
    unsafe {
        let webview = pw.controller().CoreWebView2()?.cast::<ICoreWebView2_22>()?;
        webview.AddWebResourceRequestedFilterWithRequestSourceKinds(
            &HSTRING::from(frame_host::FILTER),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
        let mut token = 0;
        webview.add_WebResourceRequested(&handler, &mut token)?;
    }
    Ok(())
}

unsafe fn request_uri(request: &ICoreWebView2WebResourceRequest) -> Option<String> {
    let mut uri = PWSTR::null();
    request.Uri(&mut uri).ok()?;
    Some(take_pwstr(uri))
}

unsafe fn request_method(request: &ICoreWebView2WebResourceRequest) -> Option<String> {
    let mut method = PWSTR::null();
    request.Method(&mut method).ok()?;
    Some(take_pwstr(method))
}

/// One request header, or None when it is absent.
unsafe fn request_header(request: &ICoreWebView2WebResourceRequest, name: &str) -> Option<String> {
    let mut value = PWSTR::null();
    request
        .Headers()
        .ok()?
        .GetHeader(&HSTRING::from(name), &mut value)
        .ok()?;
    Some(take_pwstr(value))
}

/// The webview's own resource context. Anything unreadable counts as a subresource, which a frame
/// document request then fails on, so an unknown context never mounts a document.
unsafe fn resource_kind(args: &ICoreWebView2WebResourceRequestedEventArgs) -> ResourceKind {
    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
    match args.ResourceContext(&mut context) {
        Ok(()) if context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => ResourceKind::Document,
        _ => ResourceKind::Subresource,
    }
}

unsafe fn on_request<R: Runtime>(
    app: &AppHandle<R>,
    app_data: &Path,
    env: &ICoreWebView2Environment,
    args: ICoreWebView2WebResourceRequestedEventArgs,
) {
    let Ok(request) = args.Request() else {
        return;
    };
    let Some(uri) = request_uri(&request) else {
        return;
    };
    if frame_host::parse_frame_url(&uri).is_none() {
        return;
    }

    // From here the request is ours and always gets an answer.
    let method = request_method(&request).unwrap_or_default();
    let referer = request_header(&request, "Referer");
    let dest = request_header(&request, "Sec-Fetch-Dest");
    let kind = resource_kind(&args);
    let Ok(deferral) = args.GetDeferral() else {
        set_response(
            env,
            &args,
            &frame_host::refusal(StatusCode::INTERNAL_SERVER_ERROR),
        );
        return;
    };
    let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
    PENDING.with(|pending| {
        pending.borrow_mut().insert(
            key,
            Pending {
                args,
                deferral,
                env: env.clone(),
            },
        )
    });

    let app = app.clone();
    let app_data = app_data.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut finish = Finish {
            key,
            app,
            response: None,
        };
        let (referer, dest) = (referer.as_deref(), dest.as_deref());
        let response = frame_host::respond(&app_data, &method, &uri, referer, dest, kind);
        #[cfg(debug_assertions)]
        eprintln!(
            "{}",
            frame_host::diagnostic(&method, &uri, referer, dest, kind, response.status())
        );
        finish.response = Some(response);
    });
}

/// Sets the response on a pending request and releases its deferral. Runs on the UI thread.
fn complete(key: u64, response: Response<Vec<u8>>) {
    let Some(pending) = PENDING.with(|pending| pending.borrow_mut().remove(&key)) else {
        return;
    };
    // SAFETY: the pending COM objects were created on this thread and are still referenced.
    unsafe {
        set_response(&pending.env, &pending.args, &response);
        let _ = pending.deferral.Complete();
    }
}

unsafe fn set_response(
    env: &ICoreWebView2Environment,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    response: &Response<Vec<u8>>,
) {
    let body = response.body();
    let stream = if body.is_empty() {
        None
    } else {
        SHCreateMemStream(Some(body))
    };
    let status = response.status();
    let created = env.CreateWebResourceResponse(
        stream.as_ref(),
        i32::from(status.as_u16()),
        &HSTRING::from(status.canonical_reason().unwrap_or("")),
        &HSTRING::from(frame_host::header_block(response)),
    );
    // Without a response the request falls through to the network, where a `.invalid` host
    // never resolves.
    if let Ok(created) = created {
        let _ = args.SetResponse(&created);
    }
}
