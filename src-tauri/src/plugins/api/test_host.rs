/*
 * What the API's tests call through: a host faked in memory, `admit` and `start` joined into one blocking
 * call, a method that resolves later, and the parts of a call context for running a handler directly.
 */

// -- Local Imports --
use super::*;

/// `start`, then blocks on a later job, so the call keeps its in-flight slot until it resolves. Never
/// called from an async task: blocking on the runtime from inside it panics.
pub fn run(
    admitted: &Admitted,
    args: &str,
    app_data: &Path,
    host: &dyn HostContext,
    api: &ApiState,
) -> Result<Value, ApiError> {
    match start(admitted, args, app_data, host, api) {
        Started::Done(result) => result,
        Started::Later(job) => tauri::async_runtime::block_on(job),
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
/// sent and the calls relayed, the app state and network engine the test gives it. A relayed call is
/// answered with `relay_answer`, or `unavailable` when it is unset. With `unreadable`, the
/// failure-aware reads of the settings and the OS theme fail.
#[derive(Default)]
pub(crate) struct FakeHost {
    pub settings: std::collections::HashMap<String, String>,
    pub dark: bool,
    pub events: std::sync::Mutex<Vec<HostEvent>>,
    pub window_hidden: bool,
    pub app: Option<AppState>,
    pub relayed: std::sync::Mutex<Vec<(String, String, Value)>>,
    pub relay_answer: Option<Result<Value, ApiError>>,
    pub net: Option<NetEngine>,
    /// Every setting and the OS theme read as failed.
    pub unreadable: bool,
}

impl FakeHost {
    pub fn with(mut self, key: &str, value: &str) -> FakeHost {
        self.settings.insert(key.to_string(), value.to_string());
        self
    }
}

impl HostContext for FakeHost {
    fn setting(&self, key: &str) -> Option<String> {
        self.settings.get(key).cloned()
    }

    fn os_prefers_dark(&self) -> bool {
        self.dark
    }

    fn read_setting(&self, key: &str) -> Option<Option<String>> {
        (!self.unreadable).then(|| self.setting(key))
    }

    fn read_os_dark(&self) -> Option<bool> {
        (!self.unreadable).then_some(self.dark)
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

    fn relay_call(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError> {
        let call = (id.to_string(), method.to_string(), args);
        self.relayed.lock().unwrap().push(call);
        self.relay_answer
            .clone()
            .unwrap_or_else(|| Err(ApiError::unavailable()))
    }

    fn net(&self) -> Option<NetEngine> {
        self.net.clone()
    }
}

/// A future that suspends once before it completes, so awaiting it yields to the runtime.
struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<()> {
        if self.0 {
            return std::task::Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    }
}

/// Answers `{ id, in_flight }` from the async runtime, reading the caller's in-flight count there.
fn later(ctx: &CallCtx<'_>, _: &Map<String, Value>) -> Outcome {
    let (id, api) = (ctx.id.to_string(), ctx.api.clone());
    Outcome::Later(Box::pin(async move {
        YieldOnce(false).await;
        Ok(serde_json::json!({ "id": id, "in_flight": api.in_flight(&id) }))
    }))
}

/// One method that resolves later.
pub(crate) const LATER_TABLE: &[MethodSpec] = &[MethodSpec {
    name: "test.later",
    need: Need::Ambient,
    class: RateClass::StorageRead,
    run: later,
}];

/// The parts of a `CallCtx` for calling a handler directly, as `com.example.demo` 1.0.0, with no
/// grants.
pub(crate) struct TestCall<'a> {
    pub app_data: &'a Path,
    pub host: &'a FakeHost,
    pub serving: Serving,
    pub enabled: EnabledSet,
    pub api: ApiState,
}

impl TestCall<'_> {
    pub fn ctx(&self) -> CallCtx<'_> {
        CallCtx {
            id: "com.example.demo",
            method: "",
            caller: Caller::Frame,
            serving: &self.serving,
            enabled: &self.enabled,
            app_data: self.app_data,
            host: self.host,
            api: &self.api,
            ticket: self.api.net().ticket("com.example.demo"),
        }
    }
}

pub(crate) fn test_ctx<'a>(app_data: &'a Path, host: &'a FakeHost) -> TestCall<'a> {
    let serving = Serving {
        tier: Tier::Ui,
        version: "1.0.0".into(),
        granted: Vec::new(),
        origins: Vec::new().into(),
        dev_mode: false,
    };
    TestCall {
        app_data,
        host,
        enabled: EnabledSet::only("com.example.demo", serving.clone()),
        serving,
        api: ApiState::default(),
    }
}
