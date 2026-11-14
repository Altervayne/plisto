/*
 * The plugin API: the single path every plugin call takes. `admit` decides synchronously, with short
 * in-memory locks and no I/O, whether a call may run; `run` parses its arguments and calls the method's
 * handler, which may touch the plugin's own data folder and so runs off the caller's thread. The
 * plugin id always comes from the caller, never from the arguments, and every refusal is one of the
 * closed error codes. The only player commands sent are the `playback.*` and `queue.*` methods.
 */

pub(crate) mod app;
mod cover;
mod cursor;
pub(crate) mod error;
pub(crate) mod files;
pub(crate) mod host_event;
mod kv_file;
mod library;
mod library_rows;
pub(crate) mod log;
pub(crate) mod pending;
mod playback;
pub(crate) mod rate;
#[cfg(test)]
mod sdk_parity;
pub(crate) mod sidebar;
pub(crate) mod state;
mod storage;
#[cfg(test)]
mod test_rig;
mod ui;
pub(crate) mod ui_state;

// -- Library Imports --
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use serde_json::{Map, Value};

// -- Local Imports --
use self::error::ApiError;
use self::host_event::HostEvent;
use self::pending::Pending;
use self::rate::RateClass;
use self::state::{ApiState, InFlight};
use super::manifest::Capability;
use super::paths::validate_id;
use super::state::{EnabledSet, Serving};
use crate::state::AppState;

pub const API_VERSION: u32 = 1;
pub const MAX_ARGS_BYTES: usize = 1_048_576;
pub const MAX_IN_FLIGHT: u32 = 16;

/// What a plugin must have been granted to call a method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// Every serving plugin.
    Ambient,
    Cap(Capability),
}

pub type Handler = fn(&CallCtx<'_>, &Map<String, Value>) -> Outcome;

/// What a handler produces: a result, or a request that stays open until the user or its deadline
/// ends it.
#[derive(Debug)]
pub enum Outcome {
    Done(Result<Value, ApiError>),
    Pending(Pending),
}

#[cfg(test)]
impl Outcome {
    fn done(self) -> Result<Value, ApiError> {
        match self {
            Outcome::Done(result) => result,
            Outcome::Pending(pending) => panic!("expected a result, got {pending:?}"),
        }
    }
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
    /// Sends an event to the main window. Best-effort: a window that is gone misses it.
    fn emit(&self, event: HostEvent);
    /// Whether the main window is visible and not minimized; `false` when it cannot be read.
    fn main_window_shown(&self) -> bool;
    /// The app's library, player and cover cache; absent before the app is set up.
    fn app_state(&self) -> Option<&AppState>;
}

/// Everything a handler may use. `id` is the admitted caller, never a value from the arguments.
pub struct CallCtx<'a> {
    pub id: &'a str,
    pub serving: &'a Serving,
    /// The serving set, for a handler that must re-check after waiting on a gate.
    pub enabled: &'a EnabledSet,
    pub app_data: &'a Path,
    pub host: &'a dyn HostContext,
    pub api: &'a ApiState,
}

/// A call that passed every check, holding its in-flight slot until dropped.
pub struct Admitted {
    id: String,
    serving: Serving,
    enabled: EnabledSet,
    spec: &'static MethodSpec,
    _in_flight: InFlight,
}

static TABLE: OnceLock<Vec<MethodSpec>> = OnceLock::new();

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

/// Checks a call in a fixed order, so a flood of refused calls still spends rate tokens. Takes no
/// lock but the serving set's and the API state's, and does no I/O.
pub fn admit(
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    admit_in(table(), enabled, api, id, method, args_len, now)
}

fn admit_in(
    table: &'static [MethodSpec],
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    validate_id(id).map_err(|_| ApiError::not_found())?;
    let serving = enabled.serving(id).ok_or_else(ApiError::unavailable)?;
    api.take_all(id, now)?;
    let spec = table
        .iter()
        .find(|m| m.name == method)
        .ok_or_else(ApiError::unknown_method)?;
    if args_len > MAX_ARGS_BYTES {
        return Err(ApiError::too_large("The arguments are over 1048576 bytes."));
    }
    if let Need::Cap(cap) = spec.need {
        if !serving.granted.contains(&cap) {
            return Err(ApiError::denied());
        }
    }
    api.take(id, spec.class, now)?;
    let in_flight = api.enter(id)?;
    Ok(Admitted {
        id: id.to_string(),
        serving,
        enabled: enabled.clone(),
        spec,
        _in_flight: in_flight,
    })
}

/// Parses the arguments of an admitted call and runs its handler. A pending outcome is waited on
/// here, so the call keeps its in-flight slot until it resolves.
pub fn run(
    admitted: &Admitted,
    args: &str,
    app_data: &Path,
    host: &dyn HostContext,
    api: &ApiState,
) -> Result<Value, ApiError> {
    let not_object = || ApiError::invalid_args("The arguments must be a JSON object.");
    let Ok(Value::Object(args)) = serde_json::from_str::<Value>(args) else {
        return Err(not_object());
    };
    let ctx = CallCtx {
        id: &admitted.id,
        serving: &admitted.serving,
        enabled: &admitted.enabled,
        app_data,
        host,
        api,
    };
    match (admitted.spec.run)(&ctx, &args) {
        Outcome::Done(result) => result,
        Outcome::Pending(pending) => pending.wait(host, api.ui()),
    }
}

/// `admit` then `run`, on the calling thread.
#[allow(clippy::too_many_arguments)]
pub fn dispatch(
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args: &str,
    app_data: &Path,
    host: &dyn HostContext,
    now: Instant,
) -> Result<Value, ApiError> {
    let admitted = admit(enabled, api, id, method, args.len(), now)?;
    run(&admitted, args, app_data, host, api)
}

/// A host with settings set by the test, a fixed OS theme and window state, a record of the events
/// sent, and the app state the test gives it.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeHost {
    pub settings: std::collections::HashMap<String, String>,
    pub dark: bool,
    pub events: std::sync::Mutex<Vec<HostEvent>>,
    pub window_hidden: bool,
    pub app: Option<AppState>,
}

#[cfg(test)]
impl FakeHost {
    pub fn with(mut self, key: &str, value: &str) -> FakeHost {
        self.settings.insert(key.to_string(), value.to_string());
        self
    }
}

#[cfg(test)]
impl HostContext for FakeHost {
    fn setting(&self, key: &str) -> Option<String> {
        self.settings.get(key).cloned()
    }

    fn os_prefers_dark(&self) -> bool {
        self.dark
    }

    fn emit(&self, event: HostEvent) {
        self.events.lock().unwrap().push(event);
    }

    fn main_window_shown(&self) -> bool {
        !self.window_hidden
    }

    fn app_state(&self) -> Option<&AppState> {
        self.app.as_ref()
    }
}

/// The parts of a `CallCtx` for calling a handler directly, as `com.example.demo` 1.0.0, with no
/// grants.
#[cfg(test)]
pub(crate) struct TestCall<'a> {
    pub app_data: &'a Path,
    pub host: &'a FakeHost,
    pub serving: Serving,
    pub enabled: EnabledSet,
    pub api: ApiState,
}

#[cfg(test)]
impl TestCall<'_> {
    pub fn ctx(&self) -> CallCtx<'_> {
        CallCtx {
            id: "com.example.demo",
            serving: &self.serving,
            enabled: &self.enabled,
            app_data: self.app_data,
            host: self.host,
            api: &self.api,
        }
    }
}

#[cfg(test)]
pub(crate) fn test_ctx<'a>(app_data: &'a Path, host: &'a FakeHost) -> TestCall<'a> {
    let serving = Serving {
        tier: super::manifest::Tier::Ui,
        version: "1.0.0".into(),
        granted: Vec::new(),
    };
    TestCall {
        app_data,
        host,
        enabled: EnabledSet::only("com.example.demo", serving.clone()),
        serving,
        api: ApiState::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::error::ApiCode;
    use super::*;
    use crate::plugins::lifecycle::disable;
    use crate::plugins::manifest::Tier;
    use crate::plugins::registry::{Entry, EntryState, Registry};
    use crate::plugins::revalidate::Problems;
    use crate::plugins::session::BootState;
    use crate::plugins::state::PluginsState;
    use crate::plugins::test_kit::{ui, Kit, ID};
    use serde_json::json;
    use std::time::Duration;

    fn plugins_with(granted: Vec<Capability>) -> PluginsState {
        let entry = Entry {
            id: ID.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Ui,
            enabled: true,
            granted,
            installed_at: 1,
            manifest_hash: "h".into(),
            state: EntryState::Ready,
            source_path: None,
            sidebar_collapsed: false,
            ready_enabled: None,
        };
        let registry = Registry {
            entries: vec![entry],
            ..Registry::default()
        };
        PluginsState::new(registry, Problems::new(), BootState::default())
    }

    fn nothing(_: &CallCtx<'_>, _: &Map<String, Value>) -> Outcome {
        Outcome::Done(Ok(Value::Null))
    }

    // A table with a method needing the storage grant, as the storage methods do.
    const GATED: &[MethodSpec] = &[
        MethodSpec {
            name: "test.open",
            need: Need::Ambient,
            class: RateClass::Ambient,
            run: nothing,
        },
        MethodSpec {
            name: "test.gated",
            need: Need::Cap(Capability::Storage),
            class: RateClass::StorageRead,
            run: nothing,
        },
    ];

    fn open_toast(ctx: &CallCtx<'_>, _: &Map<String, Value>) -> Outcome {
        let ui = ctx.api.ui();
        let event = host_event::UiEvent {
            request_id: ui.next_request_id(),
            id: ctx.id.to_string(),
            kind: host_event::UiKind::Toast {
                text: "Saved".into(),
                action: None,
            },
        };
        match ui.open_toast(ctx.id, event, false, Instant::now()) {
            Ok(pending) => Outcome::Pending(pending),
            Err(e) => Outcome::Done(Err(e)),
        }
    }

    // One pending method and one that returns at once, on a bucket large enough for 17 admits.
    const PENDING: &[MethodSpec] = &[
        MethodSpec {
            name: "test.toast",
            need: Need::Ambient,
            class: RateClass::StorageRead,
            run: open_toast,
        },
        MethodSpec {
            name: "test.open",
            need: Need::Ambient,
            class: RateClass::StorageRead,
            run: nothing,
        },
    ];

    /// Starts `count` toast calls on their own threads and returns once all are open.
    fn start_toasts(
        plugins: &PluginsState,
        host: &std::sync::Arc<FakeHost>,
        count: usize,
    ) -> Vec<std::thread::JoinHandle<Result<Value, ApiError>>> {
        let handles = (0..count)
            .map(|_| {
                let admitted = admit_in(
                    PENDING,
                    &plugins.enabled_set(),
                    plugins.api(),
                    ID,
                    "test.toast",
                    2,
                    Instant::now(),
                )
                .unwrap();
                let (host, api) = (host.clone(), plugins.api().clone());
                std::thread::spawn(move || run(&admitted, "{}", Path::new("unused"), &*host, &api))
            })
            .collect();
        let started = Instant::now();
        while plugins.api().ui().pending_events().len() < count {
            assert!(started.elapsed() < Duration::from_secs(2), "calls never opened");
            std::thread::sleep(Duration::from_millis(1));
        }
        handles
    }

    #[test]
    fn a_pending_call_holds_its_in_flight_slot_until_it_resolves() {
        let plugins = plugins_with(Vec::new());
        let enabled = plugins.enabled_set();
        let api = plugins.api();
        let host = std::sync::Arc::new(FakeHost::default());
        let waiting = start_toasts(&plugins, &host, 4);
        let t0 = Instant::now();
        let held: Vec<Admitted> = (0..12)
            .map(|_| admit_in(PENDING, &enabled, api, ID, "test.open", 2, t0).unwrap())
            .collect();
        assert_eq!(api.in_flight(ID), 16);
        let busy = admit_in(PENDING, &enabled, api, ID, "test.open", 2, t0);
        assert_eq!(code(busy), Some(ApiCode::Busy));

        api.ui().release(ID);
        for handle in waiting {
            assert_eq!(handle.join().unwrap(), Ok(json!({ "result": "dismissed" })));
        }
        assert_eq!(api.in_flight(ID), 12);
        drop(held);
        assert_eq!(api.in_flight(ID), 0);
    }

    #[test]
    fn forget_releases_open_calls_and_drops_gestures() {
        let plugins = plugins_with(Vec::new());
        let api = plugins.api();
        let host = std::sync::Arc::new(FakeHost::default());
        let waiting = start_toasts(&plugins, &host, 2);
        let token = api.ui().mint(ID, Instant::now());

        api.forget(ID);
        for handle in waiting {
            assert_eq!(handle.join().unwrap(), Ok(json!({ "result": "dismissed" })));
        }
        assert!(api.ui().pending_events().is_empty());
        assert_eq!(host.events.lock().unwrap().len(), 2);
        assert!(!api.ui().consume(ID, &token, Instant::now()));
        assert_eq!(api.in_flight(ID), 0);
    }

    fn code(result: Result<Admitted, ApiError>) -> Option<ApiCode> {
        result.err().map(|e| e.code)
    }

    #[test]
    fn admit_answers_each_code_at_its_step() {
        let plugins = plugins_with(Vec::new());
        let enabled = plugins.enabled_set();
        let api = ApiState::default();
        let t0 = Instant::now();
        let admit = |id: &str, method: &str, len: usize| {
            admit_in(GATED, &enabled, &api, id, method, len, t0)
        };

        // 1. A broken id is not found, before anything else is looked at.
        assert_eq!(
            code(admit("Bad Id", "nope", usize::MAX)),
            Some(ApiCode::NotFound)
        );
        // 2. A valid id that is not serving.
        assert_eq!(
            code(admit("com.example.off", "test.open", 2)),
            Some(ApiCode::Unavailable)
        );
        // 4. Unknown method, after the `all` token is spent.
        assert_eq!(code(admit(ID, "ui.toast", 2)), Some(ApiCode::UnknownMethod));
        // 5. Too large comes before the grant check.
        assert_eq!(
            code(admit(ID, "test.gated", MAX_ARGS_BYTES + 1)),
            Some(ApiCode::TooLarge)
        );
        assert!(admit(ID, "test.open", MAX_ARGS_BYTES).is_ok());
        // 6. A method needing a capability the plugin was not granted.
        assert_eq!(code(admit(ID, "test.gated", 2)), Some(ApiCode::Denied));
        // 7. The class bucket: Ambient holds 10 and one was spent above.
        for _ in 0..9 {
            assert!(admit(ID, "test.open", 2).is_ok());
        }
        let limited = admit(ID, "test.open", 2).err().unwrap();
        assert_eq!(limited.code, ApiCode::RateLimited);
        assert_eq!(limited.retry_after_ms, Some(500));
        // 3. The `all` bucket: 14 spent so far; unknown methods spend it too, then everything is
        // refused before the table is consulted.
        for _ in 0..86 {
            assert_eq!(code(admit(ID, "ui.toast", 2)), Some(ApiCode::UnknownMethod));
        }
        let limited = admit(ID, "ui.toast", 2).err().unwrap();
        assert_eq!(limited.code, ApiCode::RateLimited);
        assert_eq!(limited.retry_after_ms, Some(20));
    }

    #[test]
    fn a_granted_capability_is_admitted() {
        let plugins = plugins_with(vec![Capability::Storage]);
        let api = ApiState::default();
        let admitted = admit_in(
            GATED,
            &plugins.enabled_set(),
            &api,
            ID,
            "test.gated",
            2,
            Instant::now(),
        );
        assert!(admitted.is_ok());
    }

    #[test]
    fn the_seventeenth_admitted_call_is_busy_and_a_finished_one_frees_a_slot() {
        let plugins = plugins_with(Vec::new());
        let enabled = plugins.enabled_set();
        let api = ApiState::default();
        let t0 = Instant::now();
        let mut held: Vec<Admitted> = (0..16)
            .map(|_| admit(&enabled, &api, ID, "log.write", 2, t0).unwrap())
            .collect();
        let busy = admit(&enabled, &api, ID, "log.write", 2, t0);
        assert_eq!(code(busy), Some(ApiCode::Busy));
        held.pop();
        assert!(admit(&enabled, &api, ID, "log.write", 2, t0).is_ok());
        drop(held);
        assert_eq!(api.in_flight(ID), 0);
    }

    #[test]
    fn rate_refills_with_the_injected_clock() {
        let plugins = plugins_with(Vec::new());
        let enabled = plugins.enabled_set();
        let api = ApiState::default();
        let t0 = Instant::now();
        for _ in 0..10 {
            admit(&enabled, &api, ID, "app.info", 2, t0).unwrap();
        }
        assert!(admit(&enabled, &api, ID, "app.info", 2, t0).is_err());
        let later = t0 + Duration::from_millis(500);
        assert!(admit(&enabled, &api, ID, "app.info", 2, later).is_ok());
    }

    #[test]
    fn dispatch_answers_app_info_for_the_caller() {
        let plugins = plugins_with(vec![Capability::Storage]);
        let host = FakeHost::default().with(app::SETTING_THEME, "dark");
        let info = dispatch(
            &plugins.enabled_set(),
            plugins.api(),
            ID,
            "app.info",
            r#"{"plugin_id": "com.example.other"}"#,
            Path::new("unused"),
            &host,
            Instant::now(),
        )
        .unwrap();
        // An id in the arguments is ignored.
        assert_eq!(info["plugin_id"], ID);
        assert_eq!(info["theme"], "dark");
        assert_eq!(info["granted"], serde_json::json!(["storage"]));
    }

    #[test]
    fn arguments_that_are_not_a_json_object_are_invalid() {
        let plugins = plugins_with(Vec::new());
        let host = FakeHost::default();
        for args in ["", "not json", "[]", "5", "null", "\"{}\"", "{\"a\":"] {
            let error = dispatch(
                &plugins.enabled_set(),
                plugins.api(),
                ID,
                "app.methods",
                args,
                Path::new("unused"),
                &host,
                Instant::now() + Duration::from_secs(60),
            )
            .unwrap_err();
            assert_eq!(error.code, ApiCode::InvalidArgs, "{args:?}");
        }
    }

    #[test]
    fn methods_of_other_namespaces_are_unknown() {
        let plugins = plugins_with(Vec::new());
        let enabled = plugins.enabled_set();
        let api = ApiState::default();
        for method in [
            "ui.missing",
            "library.missing",
            "playback.missing",
            "queue.clear",
            "events.subscribe",
            "plugin.call",
            "app",
            "app.info.x",
        ] {
            let result = admit(&enabled, &api, ID, method, 2, Instant::now());
            assert_eq!(code(result), Some(ApiCode::UnknownMethod), "{method}");
        }
    }

    #[test]
    fn calls_follow_the_serving_set_through_disable_withdraw_and_replace() {
        let kit = Kit::new();
        kit.install(&ui("1.0.0", &["storage"]));
        let enabled = kit.plugins.enabled_set();
        let api = kit.plugins.api();
        let t0 = Instant::now();
        let call = |at: Duration| code(admit(&enabled, api, ID, "log.write", 2, t0 + at));

        // Installed but not enabled.
        assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));
        kit.enable(&["storage"]);
        assert_eq!(call(Duration::ZERO), None);
        let serving = enabled.serving(ID).unwrap();
        assert_eq!(serving.granted, vec![Capability::Storage]);
        assert_eq!(serving.version, "1.0.0");

        disable(&kit.data, &kit.plugins, ID).unwrap();
        assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));

        kit.enable(&["storage"]);
        assert_eq!(call(Duration::ZERO), None);
        kit.plugins.withdraw(ID);
        assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));

        // The next change puts the set back in line with the registry.
        let registry = kit.plugins.snapshot();
        kit.plugins.replace(registry.clone(), Problems::new());
        assert_eq!(call(Duration::ZERO), None);
        let mut off = registry;
        off.entries[0].enabled = false;
        kit.plugins.replace(off, Problems::new());
        assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));
    }

    #[test]
    fn disabling_forgets_the_plugins_api_state() {
        let kit = Kit::new();
        kit.install(&ui("1.0.0", &[]));
        kit.enable(&[]);
        let enabled = kit.plugins.enabled_set();
        let api = kit.plugins.api();
        let t0 = Instant::now();
        for _ in 0..10 {
            admit(&enabled, api, ID, "app.info", 2, t0).unwrap();
        }
        assert!(admit(&enabled, api, ID, "app.info", 2, t0).is_err());
        api.set_page_open(ID, true);

        disable(&kit.data, &kit.plugins, ID).unwrap();
        assert_eq!(kit.stops(), [ID]);
        assert!(!api.has_buckets(ID));
        assert_eq!(api.open_page(), None);

        // Re-enabled, the plugin starts with full buckets.
        kit.enable(&[]);
        assert!(admit(&enabled, api, ID, "app.info", 2, t0).is_ok());
    }
}
