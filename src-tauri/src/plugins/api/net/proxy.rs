/*
 * Whether Windows has a proxy configured. Plugin requests never use one: through a proxy the address
 * guard would check the proxy, not the target. The kind is read only to warn the user and to name a
 * transport failure a proxy explains (`network` / `proxy`); it never gates a request, and any read
 * that fails counts as no proxy. Only the kind leaves this module, never an address.
 *
 * Auto-detect is on by default on Windows and most networks publish nothing, so on its own it reads
 * as no proxy. Discovery runs only after a transport failure, at most once per window, on a blocking
 * thread. A configured PAC script is reported as `pac` and never evaluated.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::iter;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Url;
use windows::core::{w, Error, Result, PCWSTR, PWSTR};
use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpGetDefaultProxyConfiguration, WinHttpGetIEProxyConfigForCurrentUser,
    WinHttpGetProxyForUrl, WinHttpOpen, WINHTTP_ACCESS_TYPE_NAMED_PROXY,
    WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_AUTOPROXY_AUTO_DETECT, WINHTTP_AUTOPROXY_OPTIONS,
    WINHTTP_AUTO_DETECT_TYPE_DHCP, WINHTTP_AUTO_DETECT_TYPE_DNS_A,
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO,
};

// -- Local Imports --
use super::{Refusal, CLOSED, CONNECT, DNS, PROXY, TLS};
use crate::plugins::api::error::{ApiCode, ApiError};
use crate::plugins::api::state::lock;

/// How long a read of the settings is served from cache.
pub const READ_FOR: Duration = Duration::from_secs(30);
/// The least time between two discoveries, and how long a discovered proxy is kept.
pub const DISCOVERY_EVERY: Duration = Duration::from_secs(600);
/// The longest a failed request waits for a discovery.
pub const DISCOVERY_WAIT: Duration = Duration::from_secs(2);

const ENV_NAMES: [&str; 3] = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    None,
    /// A named proxy: the user's, the machine's, or an environment variable.
    Manual,
    /// A configuration script.
    Pac,
    /// Found by auto-detect after a request failed.
    Detected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct NetEnvironment {
    pub proxy: ProxyKind,
}

/// The current user's proxy settings, each string reduced to whether it is set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UserProxy {
    pub auto_detect: bool,
    pub auto_config: bool,
    pub proxy: bool,
}

/// Where the settings are read from. Tests inject answers.
pub trait ProxySource: Send + Sync {
    fn current_user(&self) -> Result<UserProxy>;
    /// Whether the machine-wide WinHTTP setting names a proxy.
    fn machine(&self) -> Result<bool>;
    /// Whether a proxy environment variable is set.
    fn environment(&self) -> bool;
    /// Whether auto-detect finds a proxy for `url`, an origin followed by `/`. Blocks with no bound
    /// of its own; `explain` waits at most `DISCOVERY_WAIT` for it.
    fn discover(&self, url: &str) -> Result<bool>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// What the settings say before any discovery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Settings {
    kind: ProxyKind,
    auto_detect: bool,
}

#[derive(Default)]
struct Cache {
    read: Option<(Instant, Settings)>,
    /// When the last discovery started.
    discovered_at: Option<Instant>,
    /// Until when a discovered proxy counts.
    detected_until: Option<Instant>,
}

/// The proxy state shared by every plugin request. Clones share one cache.
#[derive(Clone)]
pub struct Proxy {
    source: Arc<dyn ProxySource>,
    clock: Arc<dyn Clock>,
    cache: Arc<Mutex<Cache>>,
}

impl Proxy {
    pub fn system() -> Proxy {
        Proxy::new(Arc::new(WinHttpSource), Arc::new(SystemClock))
    }

    pub fn new(source: Arc<dyn ProxySource>, clock: Arc<dyn Clock>) -> Proxy {
        Proxy {
            source,
            clock,
            cache: Arc::default(),
        }
    }

    pub fn environment(&self) -> NetEnvironment {
        NetEnvironment { proxy: self.kind() }
    }

    pub fn kind(&self) -> ProxyKind {
        match self.settings().kind {
            ProxyKind::None if self.detected() => ProxyKind::Detected,
            kind => kind,
        }
    }

    /// Renames a `dns`, `connect`, `tls` or `closed` failure to `network` / `proxy` when a proxy is
    /// configured, or when auto-detect finds one for `url`. Every other error is returned as is.
    /// Call it outside the request's own deadline: a discovery can make it wait `DISCOVERY_WAIT`.
    pub async fn explain(&self, error: ApiError, url: &Url) -> ApiError {
        let transport = error.code == ApiCode::Network
            && matches!(error.reason, Some(DNS | CONNECT | TLS | CLOSED));
        if !transport {
            return error;
        }
        let settings = self.settings();
        let behind = settings.kind != ProxyKind::None
            || self.detected()
            || (settings.auto_detect && self.discover(url).await);
        if behind {
            Refusal::network(PROXY).into()
        } else {
            error
        }
    }

    fn settings(&self) -> Settings {
        let now = self.clock.now();
        if let Some((at, settings)) = lock(&self.cache).read {
            if now.duration_since(at) < READ_FOR {
                return settings;
            }
        }
        // Read without the lock: a slow source must not hold up another request.
        let settings = read(self.source.as_ref());
        lock(&self.cache).read = Some((now, settings));
        settings
    }

    fn detected(&self) -> bool {
        let now = self.clock.now();
        lock(&self.cache)
            .detected_until
            .is_some_and(|until| now < until)
    }

    /// Runs one discovery unless one started inside `DISCOVERY_EVERY`, and waits at most
    /// `DISCOVERY_WAIT` for it. The blocking thread records what it finds itself, so a request that
    /// stops waiting does not lose the answer.
    async fn discover(&self, url: &Url) -> bool {
        let now = self.clock.now();
        {
            let mut cache = lock(&self.cache);
            if cache
                .discovered_at
                .is_some_and(|at| now.duration_since(at) < DISCOVERY_EVERY)
            {
                return false;
            }
            cache.discovered_at = Some(now);
        }
        let source = self.source.clone();
        let clock = self.clock.clone();
        let cache = self.cache.clone();
        // The origin only: auto-detect runs the network's WPAD script against this string.
        let url = format!("{}/", url.origin().ascii_serialization());
        let task = tokio::task::spawn_blocking(move || {
            let found = source.discover(&url).unwrap_or(false);
            if found {
                lock(&cache).detected_until = Some(clock.now() + DISCOVERY_EVERY);
            }
            found
        });
        // A discovery that panics, or outlasts the wait, reads as none for this failure.
        matches!(
            tokio::time::timeout(DISCOVERY_WAIT, task).await,
            Ok(Ok(true))
        )
    }
}

fn read(source: &dyn ProxySource) -> Settings {
    let user = source.current_user().unwrap_or_default();
    let manual = user.proxy || source.machine().unwrap_or(false) || source.environment();
    let kind = if manual {
        ProxyKind::Manual
    } else if user.auto_config {
        ProxyKind::Pac
    } else {
        ProxyKind::None
    };
    Settings {
        kind,
        auto_detect: user.auto_detect,
    }
}

/// Whether any of `ENV_NAMES`, in any case, holds a non-blank value.
fn names_a_proxy(vars: impl IntoIterator<Item = (OsString, OsString)>) -> bool {
    vars.into_iter().any(|(name, value)| {
        let name = name.to_string_lossy();
        ENV_NAMES.iter().any(|n| name.eq_ignore_ascii_case(n))
            && !value.to_string_lossy().trim().is_empty()
    })
}

// ---- WinHTTP ----

pub struct WinHttpSource;

impl ProxySource for WinHttpSource {
    fn current_user(&self) -> Result<UserProxy> {
        let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        // SAFETY: fills a caller-owned struct; each string it returns is freed below.
        let read = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) };
        let user = UserProxy {
            auto_detect: config.fAutoDetect.as_bool(),
            auto_config: take(config.lpszAutoConfigUrl),
            proxy: take(config.lpszProxy),
        };
        take(config.lpszProxyBypass);
        read.map(|()| user)
    }

    fn machine(&self) -> Result<bool> {
        let mut info = WINHTTP_PROXY_INFO::default();
        // SAFETY: fills a caller-owned struct; each string it returns is freed below.
        let read = unsafe { WinHttpGetDefaultProxyConfiguration(&mut info) };
        let named = take(info.lpszProxy) && info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        take(info.lpszProxyBypass);
        read.map(|()| named)
    }

    fn environment(&self) -> bool {
        names_a_proxy(std::env::vars_os())
    }

    fn discover(&self, url: &str) -> Result<bool> {
        let wide: Vec<u16> = url.encode_utf16().chain(iter::once(0)).collect();
        // SAFETY: a static agent name and no proxy; the handle is closed below.
        let session = unsafe {
            WinHttpOpen(
                w!("Plisto"),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                PCWSTR::null(),
                PCWSTR::null(),
                0,
            )
        };
        if session.is_null() {
            return Err(Error::from_win32());
        }
        let mut options = WINHTTP_AUTOPROXY_OPTIONS {
            dwFlags: WINHTTP_AUTOPROXY_AUTO_DETECT,
            dwAutoDetectFlags: WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A,
            ..Default::default()
        };
        let mut info = WINHTTP_PROXY_INFO::default();
        // SAFETY: a live session, a NUL-terminated URL and caller-owned structs; each string it
        // returns is freed below.
        let found = unsafe {
            WinHttpGetProxyForUrl(session, PCWSTR(wide.as_ptr()), &mut options, &mut info)
        };
        let named = take(info.lpszProxy) && info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        take(info.lpszProxyBypass);
        // SAFETY: the session opened above, closed once.
        let _ = unsafe { WinHttpCloseHandle(session) };
        found.map(|()| named)
    }
}

/// Whether a string WinHTTP returned is non-empty. Frees it: each string is passed here once.
fn take(text: PWSTR) -> bool {
    if text.is_null() {
        return false;
    }
    // SAFETY: a NUL-terminated string WinHTTP allocated, not yet freed.
    let set = !unsafe { text.as_wide() }.is_empty();
    // SAFETY: WinHTTP allocates its returned strings with GlobalAlloc; this is the only free. The
    // wrapper reports the success value (null) as an error, so the result is ignored.
    let _ = unsafe { GlobalFree(HGLOBAL(text.0.cast())) };
    set
}

// ---- Test doubles ----

/// Answers set by a test, with a count of each read.
#[cfg(test)]
#[derive(Default)]
pub struct ScriptedSource {
    answer: Mutex<Answer>,
    reads: std::sync::atomic::AtomicUsize,
    discoveries: std::sync::atomic::AtomicUsize,
    asked: Mutex<Vec<String>>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Answer {
    pub user: UserProxy,
    pub machine: bool,
    pub environment: bool,
    /// What discovery finds.
    pub found: bool,
    /// How long discovery blocks.
    pub delay: Duration,
    /// Every WinHTTP call fails.
    pub fails: bool,
    pub discovery_fails: bool,
    pub discovery_panics: bool,
}

#[cfg(test)]
impl ScriptedSource {
    pub fn new(answer: Answer) -> ScriptedSource {
        let source = ScriptedSource::default();
        source.set(answer);
        source
    }

    pub fn set(&self, answer: Answer) {
        *lock(&self.answer) = answer;
    }

    pub fn reads(&self) -> usize {
        self.reads.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn discoveries(&self) -> usize {
        self.discoveries.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The URLs discovery was asked about, oldest first.
    pub fn asked(&self) -> Vec<String> {
        lock(&self.asked).clone()
    }

    fn answer(&self) -> Result<Answer> {
        let answer = *lock(&self.answer);
        if answer.fails {
            Err(windows::Win32::Foundation::E_FAIL.into())
        } else {
            Ok(answer)
        }
    }
}

#[cfg(test)]
impl ProxySource for ScriptedSource {
    fn current_user(&self) -> Result<UserProxy> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.answer().map(|a| a.user)
    }

    fn machine(&self) -> Result<bool> {
        self.answer().map(|a| a.machine)
    }

    fn environment(&self) -> bool {
        lock(&self.answer).environment
    }

    fn discover(&self, url: &str) -> Result<bool> {
        self.discoveries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        lock(&self.asked).push(url.to_string());
        let delay = lock(&self.answer).delay;
        std::thread::sleep(delay);
        match self.answer()? {
            a if a.discovery_panics => panic!("scripted discovery panic"),
            a if a.discovery_fails => Err(windows::Win32::Foundation::E_FAIL.into()),
            a => Ok(a.found),
        }
    }
}

/// A clock that moves only when a test advances it.
#[cfg(test)]
pub struct TestClock {
    start: Instant,
    offset: Mutex<Duration>,
}

#[cfg(test)]
impl TestClock {
    pub fn new() -> TestClock {
        TestClock {
            start: Instant::now(),
            offset: Mutex::new(Duration::ZERO),
        }
    }

    pub fn advance(&self, by: Duration) {
        *lock(&self.offset) += by;
    }
}

#[cfg(test)]
impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.start + *lock(&self.offset)
    }
}

#[cfg(test)]
mod tests;
