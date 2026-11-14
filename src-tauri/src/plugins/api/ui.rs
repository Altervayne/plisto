/*
 * The `ui.*` methods Plisto draws for a plugin: `ui.toast`, `ui.confirm` and `ui.open_page`. Toasts and
 * prompts stay open until the user or their deadline ends them. A prompt or a page switch must not
 * reach the user unprompted, so both pass the gate: the plugin's page is open in a shown window, or the
 * call carries a fresh gesture token from a click on the plugin's own controls. A token is spent only
 * once every other check has passed, so a refused call leaves it usable. Plugin text and tokens never
 * reach an error message or a log.
 */

// -- Library Imports --
use std::time::Instant;

use serde_json::{json, Map, Value};

// -- Local Imports --
use super::error::ApiError;
use super::host_event::{HostEvent, UiEvent, UiKind};
use super::pending::Pending;
use super::rate::RateClass;
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::plugins::manifest::{text_problem, Capability, TextProblem};
use crate::plugins::sidebar_decl::route_problem;

pub const MAX_TOAST_TEXT: usize = 140;
pub const MAX_TOAST_ACTION: usize = 24;
pub const MAX_CONFIRM_TITLE: usize = 60;
pub const MAX_CONFIRM_BODY: usize = 300;
pub const MAX_BUTTON_LABEL: usize = 24;
pub const MAX_GESTURE_BYTES: usize = 64;

pub(super) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "ui.toast",
        need: Need::Cap(Capability::UiToast),
        class: RateClass::Toast,
        run: toast,
    },
    MethodSpec {
        name: "ui.confirm",
        need: Need::Cap(Capability::UiConfirm),
        class: RateClass::Confirm,
        run: confirm,
    },
    MethodSpec {
        name: "ui.open_page",
        need: Need::Ambient,
        class: RateClass::Nav,
        run: open_page,
    },
];

/// A text argument: its name, its cap in characters and its two refusal messages.
pub(super) struct Field {
    pub(super) name: &'static str,
    pub(super) cap: usize,
    pub(super) invalid: &'static str,
    pub(super) too_long: &'static str,
}

const TOAST_TEXT: Field = Field {
    name: "text",
    cap: MAX_TOAST_TEXT,
    invalid: "'text' must be a non-blank string with no control or invisible characters.",
    too_long: "'text' is over 140 characters.",
};

const TOAST_ACTION: Field = Field {
    name: "action",
    cap: MAX_TOAST_ACTION,
    invalid: "'action' must be a non-blank string with no control or invisible characters.",
    too_long: "'action' is over 24 characters.",
};

const CONFIRM_TITLE: Field = Field {
    name: "title",
    cap: MAX_CONFIRM_TITLE,
    invalid: "'title' must be a non-blank string with no control or invisible characters.",
    too_long: "'title' is over 60 characters.",
};

const CONFIRM_BODY: Field = Field {
    name: "body",
    cap: MAX_CONFIRM_BODY,
    invalid: "'body' must be a non-blank string with no control or invisible characters.",
    too_long: "'body' is over 300 characters.",
};

const CONFIRM_LABEL: Field = Field {
    name: "confirm_label",
    cap: MAX_BUTTON_LABEL,
    invalid: "'confirm_label' must be a non-blank string with no control or invisible characters.",
    too_long: "'confirm_label' is over 24 characters.",
};

const CANCEL_LABEL: Field = Field {
    name: "cancel_label",
    cap: MAX_BUTTON_LABEL,
    invalid: "'cancel_label' must be a non-blank string with no control or invisible characters.",
    too_long: "'cancel_label' is over 24 characters.",
};

fn checked(text: &str, field: &Field) -> Result<String, ApiError> {
    match text_problem(text, field.cap) {
        None => Ok(text.to_string()),
        Some(TextProblem::TooLong) => Err(ApiError::too_large(field.too_long)),
        Some(TextProblem::Stacked) => Err(ApiError::invalid_args(
            "Text must not have more than 6 combining marks in a row.",
        )),
        Some(_) => Err(ApiError::invalid_args(field.invalid)),
    }
}

pub(super) fn text_arg(args: &Map<String, Value>, field: &Field) -> Result<String, ApiError> {
    match args.get(field.name) {
        Some(Value::String(text)) => checked(text, field),
        _ => Err(ApiError::invalid_args(field.invalid)),
    }
}

/// An optional text argument; absent and `null` both mean none.
pub(super) fn optional_text_arg(
    args: &Map<String, Value>,
    field: &Field,
) -> Result<Option<String>, ApiError> {
    match args.get(field.name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => checked(text, field).map(Some),
        Some(_) => Err(ApiError::invalid_args(field.invalid)),
    }
}

fn gesture_arg(args: &Map<String, Value>) -> Result<Option<&str>, ApiError> {
    match args.get("gesture") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(token)) if token.len() <= MAX_GESTURE_BYTES => Ok(Some(token)),
        Some(_) => Err(ApiError::invalid_args(
            "'gesture' must be a string of at most 64 bytes.",
        )),
    }
}

fn route_arg(args: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match args.get("route") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(route)) if route_problem(route).is_none() => Ok(Some(route.clone())),
        Some(_) => Err(ApiError::invalid_args(
            "'route' must be null or 1 to 64 visible ASCII characters.",
        )),
    }
}

/// Lets a prompt or a page switch through when the caller's page is open in a shown window, or when
/// `gesture` is a live token of the caller, which it then spends. A token sent alongside an open page
/// is left unspent.
pub fn gate(ctx: &CallCtx<'_>, gesture: Option<&str>, now: Instant) -> Result<(), ApiError> {
    if ctx.api.is_page_open(ctx.id) && ctx.host.main_window_shown() {
        return Ok(());
    }
    match gesture {
        Some(token) if ctx.api.ui().consume(ctx.id, token, now) => Ok(()),
        _ => Err(ApiError::no_gesture()),
    }
}

fn pending(result: Result<Pending, ApiError>) -> Outcome {
    match result {
        Ok(pending) => Outcome::Pending(pending),
        Err(e) => Outcome::Done(Err(e)),
    }
}

fn toast(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    pending(open_toast(ctx, args, Instant::now()))
}

fn open_toast(
    ctx: &CallCtx<'_>,
    args: &Map<String, Value>,
    now: Instant,
) -> Result<Pending, ApiError> {
    let text = text_arg(args, &TOAST_TEXT)?;
    let action = optional_text_arg(args, &TOAST_ACTION)?;
    let ui = ctx.api.ui();
    let event = UiEvent {
        request_id: ui.next_request_id(),
        id: ctx.id.to_string(),
        kind: UiKind::Toast {
            action: action.clone(),
            text,
        },
    };
    let pending = ui.open_toast(ctx.id, event.clone(), action.is_some(), now)?;
    ctx.host.emit(HostEvent::Ui(event));
    Ok(pending)
}

fn confirm(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    pending(open_confirm(ctx, args, Instant::now()))
}

fn open_confirm(
    ctx: &CallCtx<'_>,
    args: &Map<String, Value>,
    now: Instant,
) -> Result<Pending, ApiError> {
    let title = text_arg(args, &CONFIRM_TITLE)?;
    let body = text_arg(args, &CONFIRM_BODY)?;
    let confirm_label = text_arg(args, &CONFIRM_LABEL)?;
    let cancel_label = optional_text_arg(args, &CANCEL_LABEL)?;
    let gesture = gesture_arg(args)?;
    let ui = ctx.api.ui();
    // The caps are checked before the gate so a `busy` refusal leaves the token unspent. A second
    // prompt racing in between can still spend it and then be refused by `open_confirm`.
    ui.confirm_busy(ctx.id)?;
    gate(ctx, gesture, now)?;
    let event = UiEvent {
        request_id: ui.next_request_id(),
        id: ctx.id.to_string(),
        kind: UiKind::Confirm {
            title,
            body,
            confirm_label,
            cancel_label,
        },
    };
    let pending = ui.open_confirm(ctx.id, event.clone(), now)?;
    ctx.host.emit(HostEvent::Ui(event));
    Ok(pending)
}

fn open_page(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(request_page(ctx, args, Instant::now()))
}

/// Asks the main window to show the caller's own page. Whether the app mode lets it is the window's
/// call, so success only means the request was sent.
fn request_page(
    ctx: &CallCtx<'_>,
    args: &Map<String, Value>,
    now: Instant,
) -> Result<Value, ApiError> {
    let route = route_arg(args)?;
    let gesture = gesture_arg(args)?;
    gate(ctx, gesture, now)?;
    ctx.host.emit(HostEvent::Ui(UiEvent {
        request_id: ctx.api.ui().next_request_id(),
        id: ctx.id.to_string(),
        kind: UiKind::OpenPage { route },
    }));
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::state::ApiState;
    use crate::plugins::api::ui_state::{UiAnswer, GESTURE_MS, MAX_OPEN_PROMPTS};
    use crate::plugins::api::{admit, dispatch, method_names, test_ctx, FakeHost, TestCall};
    use crate::plugins::manifest::{Tier, MAX_COMBINING_RUN};
    use crate::plugins::state::{EnabledSet, Serving};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    const ID: &str = "com.example.demo";
    const OTHER: &str = "com.example.other";

    fn args(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("arguments must be an object"),
        }
    }

    fn call<'a>(host: &'a FakeHost) -> TestCall<'a> {
        test_ctx(Path::new("unused"), host)
    }

    fn prompt_args() -> Value {
        json!({ "title": "Delete", "body": "Remove 3 tracks?", "confirm_label": "Remove" })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Map<String, Value> {
        base[key] = value;
        args(base)
    }

    fn code<T: std::fmt::Debug>(result: Result<T, ApiError>) -> ApiCode {
        result.unwrap_err().code
    }

    fn ui_events(host: &FakeHost) -> Vec<UiEvent> {
        host.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                HostEvent::Ui(ui) => Some(ui.clone()),
                HostEvent::Sidebar(_) => None,
            })
            .collect()
    }

    fn serving(granted: Vec<Capability>) -> Serving {
        Serving {
            tier: Tier::Ui,
            version: "1.0.0".into(),
            granted,
            origins: Vec::new().into(),
            dev_mode: false,
        }
    }

    // -- Text rules --

    #[test]
    fn every_text_cap_is_counted_in_characters() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let now = Instant::now();
        let toast_with = |text: Value, action: Value| {
            open_toast(&ctx, &args(json!({ "text": text, "action": action })), now)
        };
        // One emoji is one character, though it is a surrogate pair in UTF-16 and 4 bytes in UTF-8.
        let emoji = "\u{1F600}";
        assert_eq!(emoji.encode_utf16().count(), 2);
        for (cap, field) in [(MAX_TOAST_TEXT, "text"), (MAX_TOAST_ACTION, "action")] {
            for unit in ["x", "\u{e9}", emoji] {
                let at_cap = unit.repeat(cap);
                let over = unit.repeat(cap + 1);
                let (ok, long) = if field == "text" {
                    (
                        toast_with(json!(at_cap), Value::Null),
                        toast_with(json!(over), Value::Null),
                    )
                } else {
                    (
                        toast_with(json!("Saved"), json!(at_cap)),
                        toast_with(json!("Saved"), json!(over)),
                    )
                };
                assert!(ok.is_ok(), "{field} {unit:?}");
                assert_eq!(code(long), ApiCode::TooLarge, "{field} {unit:?}");
                call.api.ui().release(ID);
            }
        }

        call.api.set_page_open(ID, true);
        for (field, cap) in [
            ("title", MAX_CONFIRM_TITLE),
            ("body", MAX_CONFIRM_BODY),
            ("confirm_label", MAX_BUTTON_LABEL),
            ("cancel_label", MAX_BUTTON_LABEL),
        ] {
            for unit in ["x", emoji] {
                let ok = open_confirm(
                    &ctx,
                    &with(prompt_args(), field, json!(unit.repeat(cap))),
                    now,
                );
                assert!(ok.is_ok(), "{field} {unit:?}");
                call.api.ui().release(ID);
                let long = with(prompt_args(), field, json!(unit.repeat(cap + 1)));
                assert_eq!(
                    code(open_confirm(&ctx, &long, now)),
                    ApiCode::TooLarge,
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn a_stack_of_combining_marks_is_refused_with_its_own_reason() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let now = Instant::now();
        let stacked = format!("A{}", "\u{0301}".repeat(MAX_COMBINING_RUN + 1));
        let err = open_toast(&ctx, &args(json!({ "text": stacked })), now).unwrap_err();
        assert_eq!(err.code, ApiCode::InvalidArgs);
        assert!(err.message.contains("combining marks"), "{}", err.message);
        let allowed = format!("A{}", "\u{0301}".repeat(MAX_COMBINING_RUN));
        assert!(open_toast(&ctx, &args(json!({ "text": allowed })), now).is_ok());
    }

    #[test]
    fn blank_control_and_invisible_text_is_refused() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        call.api.set_page_open(ID, true);
        let now = Instant::now();
        let bad = [
            json!(""),
            json!("   "),
            json!("a\nb"),
            json!("a\tb"),
            json!("\u{7}"),
            json!("a\u{7F}"),
            json!("a\u{202E}b"),
            json!("a\u{2028}b"),
            json!("a\u{200B}b"),
            json!("\u{FEFF}"),
            json!(5),
            json!(["Saved"]),
            json!({ "text": "Saved" }),
        ];
        for value in &bad {
            let toast = open_toast(&ctx, &args(json!({ "text": value })), now);
            assert_eq!(code(toast), ApiCode::InvalidArgs, "text {value}");
            let action = json!({ "text": "Saved", "action": value });
            assert_eq!(
                code(open_toast(&ctx, &args(action), now)),
                ApiCode::InvalidArgs
            );
            for field in ["title", "body", "confirm_label", "cancel_label"] {
                let prompt = open_confirm(&ctx, &with(prompt_args(), field, value.clone()), now);
                assert_eq!(code(prompt), ApiCode::InvalidArgs, "{field} {value}");
            }
        }
        // Required fields may not be missing; optional ones may be absent or null.
        assert_eq!(
            code(open_toast(&ctx, &args(json!({})), now)),
            ApiCode::InvalidArgs
        );
        for field in ["title", "body", "confirm_label"] {
            let mut missing = prompt_args();
            missing.as_object_mut().unwrap().remove(field);
            assert_eq!(
                code(open_confirm(&ctx, &args(missing), now)),
                ApiCode::InvalidArgs
            );
            let null = with(prompt_args(), field, Value::Null);
            assert_eq!(code(open_confirm(&ctx, &null, now)), ApiCode::InvalidArgs);
        }
        assert!(ui_events(&host).is_empty());
        assert!(call.api.ui().pending_events().is_empty());
    }

    #[test]
    fn a_gesture_over_64_bytes_or_not_a_string_is_refused() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let now = Instant::now();
        for gesture in [json!("g".repeat(65)), json!(5), json!(true)] {
            let prompt = with(prompt_args(), "gesture", gesture.clone());
            assert_eq!(code(open_confirm(&ctx, &prompt, now)), ApiCode::InvalidArgs);
            let page = args(json!({ "gesture": gesture }));
            assert_eq!(code(request_page(&ctx, &page, now)), ApiCode::InvalidArgs);
        }
        // 64 bytes is a well-formed token that matches nothing.
        let prompt = with(prompt_args(), "gesture", json!("g".repeat(64)));
        assert_eq!(
            open_confirm(&ctx, &prompt, now).unwrap_err(),
            ApiError::no_gesture()
        );
    }

    // -- Capabilities and rates --

    #[test]
    fn each_method_needs_its_capability() {
        let api = ApiState::default();
        let t0 = Instant::now();
        let bare = EnabledSet::only(ID, serving(Vec::new()));
        for method in ["ui.toast", "ui.confirm"] {
            let refused = admit(&bare, &api, ID, method, 2, t0);
            assert_eq!(code(refused.map(|_| ())), ApiCode::Denied, "{method}");
        }
        // The page belongs to the plugin, so no capability is needed to ask for it.
        assert!(admit(&bare, &api, ID, "ui.open_page", 2, t0).is_ok());

        let toast_only = EnabledSet::only(ID, serving(vec![Capability::UiToast]));
        assert!(admit(&toast_only, &api, ID, "ui.toast", 2, t0).is_ok());
        let refused = admit(&toast_only, &api, ID, "ui.confirm", 2, t0);
        assert_eq!(code(refused.map(|_| ())), ApiCode::Denied);
        let confirm_only = EnabledSet::only(ID, serving(vec![Capability::UiConfirm]));
        assert!(admit(&confirm_only, &api, ID, "ui.confirm", 2, t0).is_ok());
        let refused = admit(&confirm_only, &api, ID, "ui.toast", 2, t0);
        assert_eq!(code(refused.map(|_| ())), ApiCode::Denied);
    }

    #[test]
    fn a_toast_flood_passes_three_then_is_rate_limited() {
        let api = ApiState::default();
        let enabled = EnabledSet::only(ID, serving(vec![Capability::UiToast]));
        let t0 = Instant::now();
        let held: Vec<_> = (0..3)
            .map(|_| admit(&enabled, &api, ID, "ui.toast", 2, t0).unwrap())
            .collect();
        let limited = admit(&enabled, &api, ID, "ui.toast", 2, t0).err().unwrap();
        assert_eq!(limited.code, ApiCode::RateLimited);
        assert_eq!(limited.retry_after_ms, Some(10_000));
        drop(held);
        let later = t0 + Duration::from_millis(10_000);
        assert!(admit(&enabled, &api, ID, "ui.toast", 2, later).is_ok());
    }

    // -- ui.toast --

    #[test]
    fn a_toast_emits_its_event_and_resolves_dismissed_or_with_a_gesture() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let ui = call.api.ui();
        let now = Instant::now();

        let plain = open_toast(&ctx, &args(json!({ "text": "Saved", "extra": 1 })), now).unwrap();
        let events = ui_events(&host);
        assert_eq!(
            serde_json::to_value(&events[0]).unwrap(),
            json!({ "request_id": "r1", "id": ID, "kind": "toast",
                    "payload": { "text": "Saved", "action": null } })
        );
        assert!(ui.answer("r1", UiAnswer::Toast { action: true }, true, now));
        assert_eq!(plain.wait(&host, ui), Ok(json!({ "result": "dismissed" })));

        let with_action = open_toast(
            &ctx,
            &args(json!({ "text": "Saved", "action": "Undo" })),
            now,
        )
        .unwrap();
        assert_eq!(
            ui_events(&host)[1].kind,
            UiKind::Toast {
                text: "Saved".into(),
                action: Some("Undo".into())
            }
        );
        assert!(ui.answer("r2", UiAnswer::Toast { action: true }, true, now));
        let result = with_action.wait(&host, ui).unwrap();
        assert_eq!(result["result"], "action");
        assert_eq!(result.as_object().unwrap().len(), 2);
        // The gesture opens a prompt with the page closed.
        let token = result["gesture"].as_str().unwrap();
        let prompt = with(prompt_args(), "gesture", json!(token));
        assert!(open_confirm(&ctx, &prompt, now).is_ok());
    }

    #[test]
    fn the_fifth_open_toast_is_busy_and_not_announced() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let now = Instant::now();
        let held: Vec<Pending> = (0..4)
            .map(|_| open_toast(&ctx, &args(json!({ "text": "Saved" })), now).unwrap())
            .collect();
        let busy = open_toast(&ctx, &args(json!({ "text": "Saved" })), now);
        assert_eq!(code(busy), ApiCode::Busy);
        assert_eq!(ui_events(&host).len(), 4);
        drop(held);
    }

    #[test]
    fn a_toast_needs_no_gesture_from_a_background_frame() {
        let host = FakeHost {
            window_hidden: true,
            ..FakeHost::default()
        };
        let call = call(&host);
        let toast = open_toast(
            &call.ctx(),
            &args(json!({ "text": "Done" })),
            Instant::now(),
        );
        assert!(toast.is_ok());
    }

    // -- ui.confirm and the gate --

    #[test]
    fn a_prompt_emits_its_event_and_resolves_with_the_answer() {
        let host = FakeHost::default();
        let call = call(&host);
        call.api.set_page_open(ID, true);
        let ctx = call.ctx();
        let ui = call.api.ui();
        let now = Instant::now();
        let pending = open_confirm(
            &ctx,
            &with(prompt_args(), "cancel_label", json!("Keep")),
            now,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&ui_events(&host)[0]).unwrap(),
            json!({ "request_id": "r1", "id": ID, "kind": "confirm", "payload": {
                "title": "Delete", "body": "Remove 3 tracks?",
                "confirm_label": "Remove", "cancel_label": "Keep" } })
        );
        assert!(ui.answer("r1", UiAnswer::Confirm { value: true }, true, now));
        assert_eq!(pending.wait(&host, ui), Ok(json!({ "answer": true })));

        let pending = open_confirm(&ctx, &args(prompt_args()), now).unwrap();
        assert!(ui.answer("r2", UiAnswer::Confirm { value: false }, true, now));
        assert_eq!(pending.wait(&host, ui), Ok(json!({ "answer": false })));
    }

    #[test]
    fn a_second_prompt_is_busy_while_one_is_open() {
        let host = FakeHost::default();
        let call = call(&host);
        call.api.set_page_open(ID, true);
        let ctx = call.ctx();
        let now = Instant::now();
        let _open = open_confirm(&ctx, &args(prompt_args()), now).unwrap();
        assert_eq!(
            code(open_confirm(&ctx, &args(prompt_args()), now)),
            ApiCode::Busy
        );
        assert_eq!(ui_events(&host).len(), 1);
    }

    #[test]
    fn an_open_page_in_a_shown_window_passes_without_a_token_and_keeps_one_given() {
        let host = FakeHost::default();
        let call = call(&host);
        call.api.set_page_open(ID, true);
        let ctx = call.ctx();
        let now = Instant::now();
        assert_eq!(gate(&ctx, None, now), Ok(()));
        let token = call.api.ui().mint(ID, now);
        assert_eq!(gate(&ctx, Some(&token), now), Ok(()));
        assert!(call.api.ui().consume(ID, &token, now));
    }

    #[test]
    fn an_open_page_in_a_hidden_window_needs_a_token() {
        let host = FakeHost {
            window_hidden: true,
            ..FakeHost::default()
        };
        let call = call(&host);
        call.api.set_page_open(ID, true);
        let ctx = call.ctx();
        let now = Instant::now();
        assert_eq!(gate(&ctx, None, now), Err(ApiError::no_gesture()));
        let refused = open_confirm(&ctx, &args(prompt_args()), now).unwrap_err();
        assert_eq!(refused.code, ApiCode::Denied);
        assert_eq!(refused.reason, Some("no_gesture"));
        let token = call.api.ui().mint(ID, now);
        assert_eq!(gate(&ctx, Some(&token), now), Ok(()));
    }

    #[test]
    fn a_closed_page_without_a_token_is_denied_no_gesture() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        // Another plugin's open page does not count.
        call.api.set_page_open(OTHER, true);
        let refused = open_confirm(&ctx, &args(prompt_args()), Instant::now()).unwrap_err();
        assert_eq!(refused, ApiError::no_gesture());
        assert!(ui_events(&host).is_empty());
        assert!(call.api.ui().pending_events().is_empty());
    }

    #[test]
    fn a_token_opens_one_prompt_then_is_spent() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let ui = call.api.ui();
        let now = Instant::now();
        let token = ui.mint(ID, now);
        let prompt = with(prompt_args(), "gesture", json!(token));
        let pending = open_confirm(&ctx, &prompt, now).unwrap();
        assert!(ui.answer("r1", UiAnswer::Confirm { value: true }, true, now));
        assert_eq!(pending.wait(&host, ui), Ok(json!({ "answer": true })));
        assert_eq!(
            open_confirm(&ctx, &prompt, now).unwrap_err(),
            ApiError::no_gesture()
        );
    }

    #[test]
    fn an_expired_token_is_refused() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let t0 = Instant::now();
        let token = call.api.ui().mint(ID, t0);
        let late = t0 + Duration::from_millis(GESTURE_MS);
        let prompt = with(prompt_args(), "gesture", json!(token));
        assert_eq!(
            open_confirm(&ctx, &prompt, late).unwrap_err(),
            ApiError::no_gesture()
        );
    }

    #[test]
    fn another_plugins_token_is_refused_and_left_for_its_owner() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let now = Instant::now();
        let theirs = call.api.ui().mint(OTHER, now);
        let prompt = with(prompt_args(), "gesture", json!(theirs));
        assert_eq!(
            open_confirm(&ctx, &prompt, now).unwrap_err(),
            ApiError::no_gesture()
        );
        assert!(call.api.ui().consume(OTHER, &theirs, now));
    }

    #[test]
    fn a_busy_refusal_leaves_the_token_valid() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let ui = call.api.ui();
        let now = Instant::now();
        let first = with(prompt_args(), "gesture", json!(ui.mint(ID, now)));
        let _open = open_confirm(&ctx, &first, now).unwrap();
        let token = ui.mint(ID, now);
        let second = with(prompt_args(), "gesture", json!(token));
        assert_eq!(code(open_confirm(&ctx, &second, now)), ApiCode::Busy);
        assert!(ui.consume(ID, &token, now));
    }

    #[test]
    fn the_app_wide_prompt_cap_refuses_before_the_token_is_spent() {
        let host = FakeHost::default();
        let call = call(&host);
        let ui = call.api.ui();
        let now = Instant::now();
        let _others: Vec<Pending> = (0..MAX_OPEN_PROMPTS)
            .map(|i| {
                let id = format!("com.example.p{i}");
                let event = UiEvent {
                    request_id: ui.next_request_id(),
                    id: id.clone(),
                    kind: UiKind::Confirm {
                        title: "Delete".into(),
                        body: "Sure?".into(),
                        confirm_label: "Delete".into(),
                        cancel_label: None,
                    },
                };
                ui.open_confirm(&id, event, now).unwrap()
            })
            .collect();
        let token = ui.mint(ID, now);
        let prompt = with(prompt_args(), "gesture", json!(token));
        assert_eq!(code(open_confirm(&call.ctx(), &prompt, now)), ApiCode::Busy);
        assert!(ui.consume(ID, &token, now));
    }

    #[test]
    fn bad_arguments_leave_the_token_valid() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let ui = call.api.ui();
        let now = Instant::now();
        let token = ui.mint(ID, now);
        let mut prompt = with(prompt_args(), "gesture", json!(token));
        prompt.insert("title".into(), json!(""));
        assert_eq!(code(open_confirm(&ctx, &prompt, now)), ApiCode::InvalidArgs);
        let page = args(json!({ "route": "", "gesture": token }));
        assert_eq!(code(request_page(&ctx, &page, now)), ApiCode::InvalidArgs);
        assert!(ui.consume(ID, &token, now));
    }

    #[test]
    fn a_rate_refusal_leaves_the_token_valid() {
        let api = ApiState::default();
        let host = FakeHost::default();
        let enabled = EnabledSet::only(ID, serving(vec![Capability::UiConfirm]));
        let t0 = Instant::now();
        let token = api.ui().mint(ID, t0);
        let send = |args: Value| {
            dispatch(
                &enabled,
                &api,
                ID,
                "ui.confirm",
                &args.to_string(),
                Path::new("unused"),
                &host,
                t0,
            )
        };
        // The one `Confirm` token goes on a call refused for its arguments.
        assert_eq!(code(send(json!({}))), ApiCode::InvalidArgs);
        let prompt = Value::Object(with(prompt_args(), "gesture", json!(token)));
        assert_eq!(code(send(prompt)), ApiCode::RateLimited);
        assert!(api.ui().consume(ID, &token, t0));
    }

    // -- ui.open_page --

    #[test]
    fn open_page_follows_the_route_rule() {
        let host = FakeHost::default();
        let call = call(&host);
        call.api.set_page_open(ID, true);
        let ctx = call.ctx();
        let now = Instant::now();
        for route in [
            json!("settings"),
            json!("a/b?c=1#d"),
            json!("~".repeat(64)),
            Value::Null,
        ] {
            let page = args(json!({ "route": route }));
            assert_eq!(request_page(&ctx, &page, now), Ok(json!({})), "{route}");
        }
        assert_eq!(request_page(&ctx, &Map::new(), now), Ok(json!({})));
        for route in [
            json!(""),
            json!("x".repeat(65)),
            json!("a b"),
            json!("a\tb"),
            json!("caf\u{e9}"),
            json!("\u{1F600}"),
            json!(5),
            json!(["settings"]),
        ] {
            let page = args(json!({ "route": route }));
            assert_eq!(
                code(request_page(&ctx, &page, now)),
                ApiCode::InvalidArgs,
                "{route}"
            );
        }
        assert_eq!(ui_events(&host).len(), 5);
    }

    #[test]
    fn open_page_emits_its_own_page_request() {
        let host = FakeHost::default();
        let call = call(&host);
        call.api.set_page_open(ID, true);
        let page = args(json!({ "route": "settings", "id": OTHER }));
        request_page(&call.ctx(), &page, Instant::now()).unwrap();
        assert_eq!(
            serde_json::to_value(&ui_events(&host)[0]).unwrap(),
            json!({ "request_id": "r1", "id": ID, "kind": "open_page",
                    "payload": { "route": "settings" } })
        );
        // A page request is not an open request: nothing waits on it.
        assert!(call.api.ui().pending_events().is_empty());
    }

    #[test]
    fn open_page_passes_the_gate() {
        let host = FakeHost::default();
        let call = call(&host);
        let ctx = call.ctx();
        let ui = call.api.ui();
        let now = Instant::now();
        let page = |gesture: Value| args(json!({ "route": "details", "gesture": gesture }));
        // A background frame without a token stays where it is.
        assert_eq!(
            request_page(&ctx, &page(Value::Null), now),
            Err(ApiError::no_gesture())
        );
        let theirs = ui.mint(OTHER, now);
        let refused = request_page(&ctx, &page(json!(theirs)), now);
        assert_eq!(refused, Err(ApiError::no_gesture()));
        let token = ui.mint(ID, now);
        assert_eq!(request_page(&ctx, &page(json!(token)), now), Ok(json!({})));
        assert_eq!(
            request_page(&ctx, &page(json!(token)), now),
            Err(ApiError::no_gesture())
        );
        assert_eq!(ui_events(&host).len(), 1);
    }

    // -- Through the dispatch table --

    #[test]
    fn a_prompt_through_dispatch_waits_for_the_answer() {
        let api = ApiState::default();
        let host = Arc::new(FakeHost::default());
        api.set_page_open(ID, true);
        let enabled = EnabledSet::only(ID, serving(vec![Capability::UiConfirm]));
        let waiter = {
            let (api, host) = (api.clone(), host.clone());
            std::thread::spawn(move || {
                let args = prompt_args().to_string();
                let now = Instant::now();
                dispatch(
                    &enabled,
                    &api,
                    ID,
                    "ui.confirm",
                    &args,
                    Path::new("unused"),
                    &*host,
                    now,
                )
            })
        };
        let started = Instant::now();
        while api.ui().pending_events().is_empty() {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the prompt never opened"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(api.ui().answer(
            "r1",
            UiAnswer::Confirm { value: true },
            true,
            Instant::now()
        ));
        assert_eq!(waiter.join().unwrap(), Ok(json!({ "answer": true })));
        assert_eq!(api.in_flight(ID), 0);
    }

    #[test]
    fn the_ui_methods_are_in_the_table() {
        let names = method_names();
        for name in ["ui.toast", "ui.confirm", "ui.open_page"] {
            assert!(names.contains(&name), "{name}");
        }
    }
}
