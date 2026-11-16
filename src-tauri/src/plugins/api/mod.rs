/*
 * The plugin API: the single path every plugin call takes. `admit` decides synchronously, with short
 * in-memory locks and no I/O, whether a call may run; `start` parses its arguments and calls the
 * method's handler, which may touch the plugin's own data folder and so runs off the caller's thread.
 * The plugin id always comes from the caller, never from the arguments, and every refusal is one of the
 * closed error codes. The only player commands sent are the `playback.*`, `queue.*` and `stream.*`
 * methods.
 * A call comes from a plugin frame, through the main window, or from a native plugin's child, through
 * its pipe. Both pass the same checks; a frame of a native plugin may also call its own child through
 * `plugin.*`, and a child reaches neither that namespace nor the network methods.
 */

pub(crate) mod app;
mod cover;
mod cursor;
pub(crate) mod error;
pub(crate) mod events;
pub(crate) mod files;
pub(crate) mod host_event;
mod kv_file;
mod library;
mod library_rows;
pub(crate) mod log;
mod net;
pub(crate) mod pending;
mod playback;
pub(crate) mod rate;
#[cfg(test)]
mod sdk_parity;
pub(crate) mod sidebar;
pub(crate) mod state;
mod storage;
pub(crate) mod stream;
pub(crate) mod tauri_host;
#[cfg(test)]
mod test_host;
#[cfg(test)]
mod test_rig;
#[cfg(test)]
mod tests;
mod ui;
pub(crate) mod ui_state;

// -- Library Imports --
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use serde_json::{Map, Value};

// -- Local Imports --
use self::error::ApiError;
use self::events::ChildDelivery;
use self::host_event::HostEvent;
use self::pending::Pending;
use self::rate::RateClass;
use self::state::{ApiState, InFlight};
use super::manifest::{Capability, Tier};
use super::paths::validate_id;
use super::state::{EnabledSet, Serving};
use crate::state::AppState;

pub(crate) use self::net::methods::{environment as net_environment, fetch as net_fetch};
pub(crate) use self::net::methods::{Fetched, NetEngine};
pub(crate) use self::net::proxy::{NetEnvironment, ProxyKind};
pub(crate) use self::net::state::{NetLogEntry, Ticket};

// Lets command tests hold and inspect network entries without opening the module crate-wide.
#[cfg(test)]
pub(crate) use self::net::methods::NetFixture;
#[cfg(test)]
pub(crate) use self::net::state::{EndReason, Kind, Running};
#[cfg(test)]
pub(crate) use self::test_host::{dispatch, run, test_ctx, FakeHost, TestCall, LATER_TABLE};

pub const API_VERSION: u32 = 1;
pub const MAX_ARGS_BYTES: usize = 1_048_576;
pub const MAX_IN_FLIGHT: u32 = 16;
/// Each app-wide cap is the per-plugin cap times this, so that many plugins at their full caps never
/// refuse one another.
pub const PLUGINS_AT_FULL_CAP: usize = 16;
/// The namespace a native plugin's page calls its own child through.
pub const RELAY_PREFIX: &str = "plugin.";
const NAME_MAX_CHARS: usize = 64;

/// Where a call comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// A plugin frame, through the main window.
    Frame,
    /// A native plugin's child, through its pipe.
    Child,
}

/// What a plugin must have been granted to call a method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// Every serving plugin.
    Ambient,
    Cap(Capability),
    /// Every one of these.
    All(&'static [Capability]),
}

impl Need {
    /// The capabilities a plugin must hold; none for an ambient method.
    pub fn caps(&self) -> &[Capability] {
        match self {
            Need::Ambient => &[],
            Need::Cap(cap) => std::slice::from_ref(cap),
            Need::All(caps) => caps,
        }
    }

    pub fn met_by(&self, granted: &[Capability]) -> bool {
        self.caps().iter().all(|cap| granted.contains(cap))
    }
}

pub type Handler = fn(&CallCtx<'_>, &Map<String, Value>) -> Outcome;

/// Work that finishes on the async runtime, such as a network request.
pub type NetJob = Pin<Box<dyn Future<Output = Result<Value, ApiError>> + Send>>;

/// What a handler produces: a result, a request that stays open until the user or its deadline ends
/// it, or a job to await.
pub enum Outcome {
    Done(Result<Value, ApiError>),
    Pending(Pending),
    Later(NetJob),
}

impl fmt::Debug for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Outcome::Done(result) => f.debug_tuple("Done").field(result).finish(),
            Outcome::Pending(pending) => f.debug_tuple("Pending").field(pending).finish(),
            Outcome::Later(_) => f.write_str("Later"),
        }
    }
}

#[cfg(test)]
impl Outcome {
    fn done(self) -> Result<Value, ApiError> {
        match self {
            Outcome::Done(result) => result,
            other => panic!("expected a result, got {other:?}"),
        }
    }
}

/// How `start` leaves a call: answered, or a job the caller awaits while it keeps the call admitted.
pub enum Started {
    Done(Result<Value, ApiError>),
    Later(NetJob),
}

#[derive(Clone, Copy)]
pub struct MethodSpec {
    pub name: &'static str,
    pub need: Need,
    pub class: RateClass,
    pub run: Handler,
}

/// What the host tells a handler about the app around the plugin.
pub trait HostContext: Send + Sync {
    /// A row of the settings table; absent when unset or unreadable.
    fn setting(&self, key: &str) -> Option<String>;
    fn os_prefers_dark(&self) -> bool;
    /// `setting`, telling an unset row (`Some(None)`) from one that could not be read (`None`).
    fn read_setting(&self, key: &str) -> Option<Option<String>> {
        Some(self.setting(key))
    }
    /// `os_prefers_dark`; None when the OS theme cannot be read.
    fn read_os_dark(&self) -> Option<bool> {
        Some(self.os_prefers_dark())
    }
    /// Sends an event to the main window. Best-effort: a window that is gone misses it.
    fn emit(&self, event: HostEvent);
    /// Whether the main window is visible and not minimized; `false` when it cannot be read.
    fn main_window_shown(&self) -> bool;
    /// The app's library, player and cover cache; absent before the app is set up.
    fn app_state(&self) -> Option<&AppState>;
    /// Hands `method`, without its `plugin.` prefix, to plugin `id`'s child and waits for its answer.
    fn relay_call(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError>;
    /// The network engine, reporting to the main window; none on a host that cannot deliver its
    /// events, where the network methods are `unavailable`.
    fn net(&self) -> Option<NetEngine> {
        None
    }
    /// Hands an app event topic, produced as delivery `seq`, to plugin `id`'s native child; a host
    /// with no children has none running.
    fn deliver_event(&self, _id: &str, _topic: &str, _data: &Value, _seq: u64) -> ChildDelivery {
        ChildDelivery::NotRunning
    }
}

/// Everything a handler may use. `id` is the admitted caller, never a value from the arguments.
pub struct CallCtx<'a> {
    pub id: &'a str,
    /// The method as called.
    pub method: &'a str,
    pub caller: Caller,
    pub serving: &'a Serving,
    /// The serving set, for a handler that must re-check after waiting on a gate.
    pub enabled: &'a EnabledSet,
    pub app_data: &'a Path,
    pub host: &'a dyn HostContext,
    pub api: &'a ApiState,
    /// The network ticket taken with `serving`, which network work registers under.
    pub ticket: Ticket,
}

/// A call that passed every check, holding its in-flight slot until dropped.
pub struct Admitted {
    id: String,
    method: String,
    caller: Caller,
    serving: Serving,
    enabled: EnabledSet,
    ticket: Ticket,
    spec: &'static MethodSpec,
    _in_flight: InFlight,
}

static TABLE: OnceLock<Vec<MethodSpec>> = OnceLock::new();

/// Every `plugin.*` call of a native plugin's page. Not in the table, so `app.methods` never lists it.
static RELAY: MethodSpec = MethodSpec {
    name: "plugin.*",
    need: Need::Ambient,
    class: RateClass::Relay,
    run: relay,
};

/// Every method this build answers.
pub fn table() -> &'static [MethodSpec] {
    TABLE.get_or_init(|| {
        [
            app::METHODS,
            storage::METHODS,
            log::METHODS,
            ui::METHODS,
            sidebar::METHODS,
            library::METHODS,
            cover::METHODS,
            playback::METHODS,
            net::methods::METHODS,
            stream::METHODS,
            events::METHODS,
        ]
        .concat()
    })
}

/// The method names, sorted and unique.
pub fn method_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = table().iter().map(|m| m.name).collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// A relayed method name or a page-event topic: 1 to 64 characters of `[a-z0-9_.-]`.
pub fn name_ok(name: &str) -> bool {
    (1..=NAME_MAX_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-'))
}

/// Checks a frame's call in a fixed order, so a flood of refused calls still spends rate tokens. Takes
/// no lock but the serving set's and the API state's, and does no I/O.
pub fn admit(
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    admit_as(table(), Caller::Frame, enabled, api, id, method, args_len, now)
}

/// `admit` for a call from `caller`.
pub fn admit_from(
    caller: Caller,
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    admit_as(table(), caller, enabled, api, id, method, args_len, now)
}

/// `admit` against `table` in place of the method table.
pub(crate) fn admit_in(
    table: &'static [MethodSpec],
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    admit_as(table, Caller::Frame, enabled, api, id, method, args_len, now)
}

/// The spec `method` names for `caller`. `plugin.*` belongs to the pages of native plugins, and the
/// network methods to frames, so a child gets neither.
fn lookup(
    table: &'static [MethodSpec],
    caller: Caller,
    tier: Tier,
    method: &str,
) -> Result<&'static MethodSpec, ApiError> {
    if let Some(name) = method.strip_prefix(RELAY_PREFIX) {
        if caller == Caller::Child || tier != Tier::Native {
            return Err(ApiError::unknown_method());
        }
        if !name_ok(name) {
            return Err(ApiError::invalid_args(
                "A 'plugin.' method name must be 1 to 64 characters of a-z, 0-9, '_', '.' and '-'.",
            ));
        }
        return Ok(&RELAY);
    }
    if caller == Caller::Child && method.starts_with("net.") {
        return Err(ApiError::unknown_method());
    }
    table
        .iter()
        .find(|m| m.name == method)
        .ok_or_else(ApiError::unknown_method)
}

#[allow(clippy::too_many_arguments)]
fn admit_as(
    table: &'static [MethodSpec],
    caller: Caller,
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    validate_id(id).map_err(|_| ApiError::not_found())?;
    // Taken before the snapshot, so a forget between the two leaves the ticket stale, never the
    // snapshot alone.
    let ticket = api.net().ticket(id);
    let serving = enabled.serving(id).ok_or_else(ApiError::unavailable)?;
    api.take_all(id, now)?;
    let spec = lookup(table, caller, serving.tier, method)?;
    if args_len > MAX_ARGS_BYTES {
        return Err(ApiError::too_large("The arguments are over 1048576 bytes."));
    }
    if !spec.need.met_by(&serving.granted) {
        return Err(ApiError::denied());
    }
    api.take(id, spec.class, now)?;
    let in_flight = api.enter(id)?;
    Ok(Admitted {
        id: id.to_string(),
        method: method.to_string(),
        caller,
        serving,
        enabled: enabled.clone(),
        ticket,
        spec,
        _in_flight: in_flight,
    })
}

/// Parses the arguments of an admitted call and runs its handler on the calling thread. A pending
/// outcome is waited on here; a later one is handed back, and the caller keeps `admitted`, with its
/// in-flight slot, until the job resolves.
pub fn start(
    admitted: &Admitted,
    args: &str,
    app_data: &Path,
    host: &dyn HostContext,
    api: &ApiState,
) -> Started {
    let not_object = || ApiError::invalid_args("The arguments must be a JSON object.");
    let Ok(Value::Object(args)) = serde_json::from_str::<Value>(args) else {
        return Started::Done(Err(not_object()));
    };
    let ctx = CallCtx {
        id: &admitted.id,
        method: &admitted.method,
        caller: admitted.caller,
        serving: &admitted.serving,
        enabled: &admitted.enabled,
        app_data,
        host,
        api,
        ticket: admitted.ticket,
    };
    match (admitted.spec.run)(&ctx, &args) {
        Outcome::Done(result) => Started::Done(result),
        Outcome::Pending(pending) => Started::Done(pending.wait(host, api.ui())),
        Outcome::Later(job) => Started::Later(job),
    }
}

/// `start` on a blocking thread, then awaits a job it hands back. `admitted` lives until the job
/// resolves, so the call keeps its in-flight slot that long.
pub async fn complete(
    admitted: Admitted,
    args: String,
    app_data: PathBuf,
    host: Arc<dyn HostContext>,
    api: ApiState,
) -> Result<Value, ApiError> {
    let started = tauri::async_runtime::spawn_blocking(move || {
        let started = start(&admitted, &args, &app_data, &*host, &api);
        (started, admitted)
    })
    .await;
    match started {
        Ok((Started::Done(result), _)) => result,
        Ok((Started::Later(job), admitted)) => {
            let result = job.await;
            drop(admitted);
            result
        }
        Err(_) => Err(ApiError::unavailable()),
    }
}

/// Hands a `plugin.*` call to the caller's own child; blocks until it answers or the wait ends.
fn relay(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    let method = ctx.method.strip_prefix(RELAY_PREFIX).unwrap_or(ctx.method);
    Outcome::Done(ctx.host.relay_call(ctx.id, method, Value::Object(args.clone())))
}
