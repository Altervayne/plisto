/*
 * The browser command line every Plisto webview starts with. Beyond wry's own defaults it closes
 * WebRTC as a way out of the machine, which CSP does not cover: a page can still build a peer
 * connection, but its UDP is refused by the IP handling policy and its TCP (TURN over TCP, and the
 * DNS lookup of a TURN host) goes to a proxy on a port where nothing listens. No Plisto webview
 * needs a real network connection: pages, covers, IPC and plugin frames are custom protocols, and
 * plugin network requests run in Rust. A dev build still reaches the dev server directly.
 *
 * All webviews sharing a user-data folder must start with identical options, so every window gets
 * the same string, and a window created at runtime must take it from here too.
 */

// -- Library Imports --
use tauri::{Config, Url};

// What wry passes when a window sets no browser args of its own: the mini menu, the PDF mini menu
// and SmartScreen off, and autoplay without a gesture (wry's `autoplay` attribute defaults to true
// and Tauri never turns it off). Setting any args drops these, so they are restated here.
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --autoplay-policy=no-user-gesture-required";

// The wry release `WRY_DEFAULT_ARGS` was read from.
#[cfg(test)]
pub const WRY_DEFAULTS_FROM: &str = "0.57.1";

// Both spellings: which one the runtime reads has changed between versions, and WebView2 is
// evergreen.
const WEBRTC_POLICY_ARGS: &str = "--webrtc-ip-handling-policy=disable_non_proxied_udp \
     --force-webrtc-ip-handling-policy=disable_non_proxied_udp";

// Port 1 on loopback refuses every connection.
const REFUSING_PROXY: &str = "--proxy-server=http://127.0.0.1:1";

// `<-loopback>` removes Chromium's implicit loopback bypass, so a peer connection to a local
// address goes to the refusing proxy as well.
const BYPASS_NOTHING: &str = "<-loopback>";

/// The full argument string. `dev_url` is the dev server a dev build loads from, the only address
/// that skips the proxy (Vite's HMR socket shares its port). `None` for a release build.
pub fn browser_args(dev_url: Option<&Url>) -> String {
    let mut bypass = String::from(BYPASS_NOTHING);
    if let Some(url) = dev_url {
        if let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) {
            // Chromium reads bypass rules last to first, so this entry wins over `<-loopback>`.
            bypass.push_str(&format!(";{host}:{port}"));
        }
    }
    format!("{WRY_DEFAULT_ARGS} {WEBRTC_POLICY_ARGS} {REFUSING_PROXY} --proxy-bypass-list={bypass}")
}

/// Gives every configured window the guarded browser args for this build.
pub fn apply(config: &mut Config) {
    apply_for(config, tauri::is_dev());
}

/// Gives every configured window the guarded browser args; `dev` lets the dev server through.
fn apply_for(config: &mut Config, dev: bool) {
    let dev_url = if dev {
        config.build.dev_url.clone()
    } else {
        None
    };
    let args = browser_args(dev_url.as_ref());
    for window in &mut config.app.windows {
        window.additional_browser_args = Some(args.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    const DEV_ARGS_BYPASS: &str = "<-loopback>;localhost:1420";

    fn crate_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn conf() -> Value {
        serde_json::from_str(&fs::read_to_string(crate_root().join("tauri.conf.json")).unwrap())
            .unwrap()
    }

    fn bypass_list(args: &str) -> &str {
        let lists: Vec<&str> = args
            .split(' ')
            .filter_map(|a| a.strip_prefix("--proxy-bypass-list="))
            .collect();
        assert_eq!(lists.len(), 1, "{args}");
        lists[0]
    }

    #[test]
    fn the_release_args_close_webrtc_and_keep_wry_defaults() {
        let args = browser_args(None);
        assert_eq!(
            args,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --autoplay-policy=no-user-gesture-required \
             --webrtc-ip-handling-policy=disable_non_proxied_udp \
             --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
             --proxy-server=http://127.0.0.1:1 --proxy-bypass-list=<-loopback>"
        );
        assert!(args.starts_with(WRY_DEFAULT_ARGS));
        assert_eq!(bypass_list(&args), "<-loopback>");
        assert!(!args.contains("  "));
    }

    #[test]
    fn the_dev_args_bypass_only_the_dev_server() {
        let url = Url::parse("http://localhost:1420").unwrap();
        let args = browser_args(Some(&url));
        assert_eq!(bypass_list(&args), DEV_ARGS_BYPASS);
        assert_eq!(
            args.replace(bypass_list(&args), ""),
            browser_args(None).replace("<-loopback>", "")
        );
    }

    #[test]
    fn the_dev_endpoint_matches_the_config() {
        let dev_url = conf()["build"]["devUrl"].as_str().unwrap().to_string();
        let url = Url::parse(&dev_url).unwrap();
        let port = url.port().unwrap();
        let host = url.host_str().unwrap();
        let args = browser_args(Some(&url));
        assert_eq!(bypass_list(&args), format!("<-loopback>;{host}:{port}"));

        let vite = fs::read_to_string(crate_root().join("../vite.config.ts")).unwrap();
        assert!(
            vite.contains(&format!("port: {port},")),
            "vite.config.ts no longer serves on port {port}, the devUrl port: keep the two equal \
             so the dev server stays outside the refusing proxy"
        );
    }

    #[test]
    fn no_window_sets_its_own_browser_args_or_proxy() {
        for window in conf()["app"]["windows"].as_array().unwrap() {
            for key in ["additionalBrowserArgs", "proxyUrl"] {
                assert!(
                    window.get(key).is_none(),
                    "window {} sets `{key}`, which the WebRTC guard would overwrite or undo; \
                     change webview_guard.rs instead",
                    window["label"]
                );
            }
        }
    }

    fn guarded_config(dev: bool) -> Vec<String> {
        let mut config: Config = serde_json::from_value(conf()).unwrap();
        assert!(config.app.windows.len() >= 3);
        assert!(config.build.dev_url.is_some());
        apply_for(&mut config, dev);
        config
            .app
            .windows
            .iter()
            .map(|w| w.additional_browser_args.clone().unwrap())
            .collect()
    }

    #[test]
    fn a_release_build_ignores_the_dev_url() {
        for args in guarded_config(false) {
            assert_eq!(args, browser_args(None));
            assert_eq!(bypass_list(&args), "<-loopback>");
        }
    }

    #[test]
    fn a_dev_build_lets_only_the_dev_server_through() {
        for args in guarded_config(true) {
            assert_eq!(bypass_list(&args), DEV_ARGS_BYPASS);
        }
    }

    #[test]
    fn the_app_builder_runs_the_guard() {
        let lib = fs::read_to_string(crate_root().join("src/lib.rs")).unwrap();
        let why = "lib.rs must build the context once, pass it through \
                   webview_guard::apply(context.config_mut()) and hand that context to \
                   .build(context); otherwise the windows start without the args that keep \
                   WebRTC from leaving the machine";
        assert!(
            lib.contains("webview_guard::apply(context.config_mut())"),
            "{why}"
        );
        assert!(lib.contains(".build(context)"), "{why}");
        assert_eq!(lib.matches("generate_context!").count(), 1, "{why}");
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    fn is_comment(line: &str) -> bool {
        let line = line.trim_start();
        line.starts_with("//") || line.starts_with('*') || line.starts_with("/*")
    }

    #[test]
    fn runtime_windows_take_the_guarded_args() {
        let mut files = Vec::new();
        rust_files(&crate_root().join("src"), &mut files);
        assert!(files.len() > 10);
        for path in files {
            if path.ends_with("webview_guard.rs") {
                continue;
            }
            let source = fs::read_to_string(&path).unwrap();
            let guarded = source
                .lines()
                .any(|l| !is_comment(l) && l.contains("webview_guard::browser_args("));
            for builder in [
                "WebviewWindowBuilder",
                "WebviewBuilder",
                "WindowBuilder",
                "WebviewWindow::builder",
                "Webview::builder",
                "add_child",
            ] {
                assert!(
                    !source.contains(builder) || guarded,
                    "{} creates a window or webview at runtime ({builder}) without calling \
                     webview_guard::browser_args. Every webview must start with the same args, or \
                     it fails to share the environment and reopens the WebRTC path.",
                    path.display()
                );
            }
        }
    }

    /// Every permission identifier in a capability file: plain strings and `identifier` fields.
    fn permission_ids(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|v| permission_ids(v, out)),
            Value::Object(map) => {
                if let Some(Value::Array(perms)) = map.get("permissions") {
                    for perm in perms {
                        match perm {
                            Value::String(id) => out.push(id.clone()),
                            Value::Object(p) => {
                                if let Some(Value::String(id)) = p.get("identifier") {
                                    out.push(id.clone());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if let Some(caps) = map.get("capabilities") {
                    permission_ids(caps, out);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn no_capability_lets_the_frontend_create_windows() {
        let dir = crate_root().join("capabilities");
        let mut ids = Vec::new();
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let value: Value =
                    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
                permission_ids(&value, &mut ids);
            }
        }
        assert!(!ids.is_empty());
        for id in ids {
            // core:window:allow-create, core:webview:allow-create-webview(-window).
            assert!(
                !id.contains("allow-create"),
                "capability permission `{id}` lets the frontend create a window or webview. A \
                 window created from JS would not carry the guarded browser args from \
                 webview_guard.rs."
            );
        }
    }
}
