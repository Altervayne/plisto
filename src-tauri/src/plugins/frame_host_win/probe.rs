/*
 * The probe host's WebView2 side, compiled into debug builds only: a second WebResourceRequested
 * handler on the main webview with its own filter. Each handler returns at once on a URI it does not
 * parse, so the probe host and the plugin frame host never answer the same request. Pending requests
 * share the plugin frame host's map, keys and completion path.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::http::StatusCode;
use tauri::webview::PlatformWebview;
use tauri::{AppHandle, Runtime};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment, ICoreWebView2WebResourceRequestedEventArgs, ICoreWebView2_22,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
};
use webview2_com::WebResourceRequestedEventHandler;
use windows62::core::{Interface, Result, HSTRING};

// -- Local Imports --
use super::{
    request_header, request_method, request_uri, resource_kind, set_response, Finish, Pending,
    NEXT_KEY, PENDING,
};
use crate::plugins::frame_host;
use crate::plugins::frame_host::probe::{parse_probe_url, respond, PROBE_FILTER};

/// Registers the probe host on one webview. A failure is printed and changes nothing else.
pub(super) fn install<R: Runtime>(pw: &PlatformWebview, app: AppHandle<R>) {
    if let Err(e) = register(pw, app) {
        eprintln!("[probe-host] not installed: {e}");
    }
}

fn register<R: Runtime>(pw: &PlatformWebview, app: AppHandle<R>) -> Result<()> {
    let env = pw.environment();
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            // SAFETY: called by WebView2 on the UI thread with live event args.
            unsafe { on_request(&app, &env, args) };
        }
        Ok(())
    }));
    // SAFETY: the controller and its webview are live for the duration of `with_webview`.
    unsafe {
        let webview = pw.controller().CoreWebView2()?.cast::<ICoreWebView2_22>()?;
        webview.AddWebResourceRequestedFilterWithRequestSourceKinds(
            &HSTRING::from(PROBE_FILTER),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
        let mut token = 0;
        webview.add_WebResourceRequested(&handler, &mut token)?;
    }
    Ok(())
}

unsafe fn on_request<R: Runtime>(
    app: &AppHandle<R>,
    env: &ICoreWebView2Environment,
    args: ICoreWebView2WebResourceRequestedEventArgs,
) {
    let Ok(request) = args.Request() else {
        return;
    };
    let Some(uri) = request_uri(&request) else {
        return;
    };
    if parse_probe_url(&uri).is_none() {
        return;
    }

    // From here the request is ours and always gets an answer.
    let method = request_method(&request).unwrap_or_default();
    let referer = request_header(&request, "Referer");
    let dest = request_header(&request, "Sec-Fetch-Dest");
    let origin = request_header(&request, "Origin");
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut finish = Finish {
            key,
            app,
            response: None,
        };
        let (referer, dest, origin) = (referer.as_deref(), dest.as_deref(), origin.as_deref());
        finish.response = Some(respond(&method, &uri, referer, dest, kind, origin));
    });
}
