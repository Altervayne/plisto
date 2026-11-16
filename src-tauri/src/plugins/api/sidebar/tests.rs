// The sidebar methods, called through the dispatch: declared items, state changes and their limits.

// -- Library Imports --
use std::fs;

// -- Local Imports --
use super::*;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::{admit, dispatch, method_names, test_ctx, FakeHost, TestCall};
use crate::plugins::manifest::Tier;
use crate::plugins::paths::plugin_dir;
use crate::plugins::stage::Temp;
use crate::plugins::state::Serving;

const ID: &str = "com.example.demo";
const OTHER: &str = "com.example.other";

fn manifest(sidebar: Option<Value>) -> String {
    let mut value = json!({
        "manifest_version": 1, "id": ID, "name": "Demo", "version": "1.0.0", "tier": "ui",
        "entry": "index.html", "min_plisto": "1.0.0", "author": "A",
        "capabilities": ["background", "ui.chips", "ui.sidebar"],
    });
    if let Some(sidebar) = sidebar {
        value["sidebar"] = sidebar;
    }
    value.to_string()
}

fn full_sidebar() -> Value {
    json!({ "layout": "section", "items": [
            { "id": "home", "type": "nav", "label": "Home", "icon": "music", "route": "/home" },
            { "id": "st", "type": "status", "label": "Idle" },
            { "id": "pr", "type": "progress", "label": "Sync" },
            { "id": "tg", "type": "toggle", "label": "Watch" },
            { "id": "go", "type": "action", "label": "Run" } ] })
}

/// An app data folder holding the demo plugin's installed manifest.
fn data_with(text: &str) -> Temp {
    let temp = Temp::new("sidebar");
    let dir = plugin_dir(&temp.0, ID);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), text).unwrap();
    temp
}

fn args(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("arguments must be an object"),
    }
}

fn call<'a>(temp: &'a Temp, host: &'a FakeHost) -> TestCall<'a> {
    test_ctx(&temp.0, host)
}

fn put(call: &TestCall<'_>, item: &str, state: Value) -> Result<Value, ApiError> {
    let given = args(json!({ "item_id": item, "state": state }));
    update(&call.ctx(), &given).done()
}

fn code<T: std::fmt::Debug>(result: Result<T, ApiError>) -> ApiCode {
    result.unwrap_err().code
}

fn sidebar_events(host: &FakeHost) -> Vec<Value> {
    host.events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            HostEvent::Sidebar(event) => Some(serde_json::to_value(event).unwrap()),
            _ => None,
        })
        .collect()
}

fn serving(tier: Tier, granted: Vec<Capability>) -> Serving {
    Serving {
        tier,
        version: "1.0.0".into(),
        granted,
        origins: Vec::new().into(),
        dev_mode: false,
    }
}

fn put_chips(call: &TestCall<'_>, chips: Value) -> Result<Value, ApiError> {
    self::chips(&call.ctx(), &args(json!({ "chips": chips }))).done()
}

// -- ui.chips --

#[test]
fn chips_take_text_or_a_count_with_a_tone() {
    let (temp, host) = (data_with(&manifest(None)), FakeHost::default());
    let call = call(&temp, &host);
    let result = put_chips(
        &call,
        json!([{ "text": "New" }, { "count": 3, "tone": "accent", "extra": 1 }]),
    );
    assert_eq!(result, Ok(json!({})));
    let snapshot = call.api.sidebar().snapshot(&call.enabled);
    assert_eq!(
        snapshot[0].chips,
        vec![
            Chip {
                text: Some("New".into()),
                count: None,
                tone: Tone::Neutral
            },
            Chip {
                text: None,
                count: Some(3),
                tone: Tone::Accent
            },
        ]
    );
    assert_eq!(
        sidebar_events(&host),
        vec![json!({ "id": ID, "kind": "chips", "chips": [
                { "text": "New", "count": null, "tone": "neutral" },
                { "text": null, "count": 3, "tone": "accent" } ] })]
    );
}

#[test]
fn a_chip_needs_exactly_one_of_text_and_count() {
    let (temp, host) = (data_with(&manifest(None)), FakeHost::default());
    let call = call(&temp, &host);
    for chip in [
        json!({}),
        json!({ "tone": "warn" }),
        json!({ "text": "a", "count": 1 }),
        json!({ "text": null, "count": null }),
        json!("text"),
        json!(5),
    ] {
        assert_eq!(
            code(put_chips(&call, json!([chip.clone()]))),
            ApiCode::InvalidArgs,
            "{chip}"
        );
    }
    assert!(sidebar_events(&host).is_empty());
}

#[test]
fn a_chip_count_is_an_integer_from_zero_to_i32_max() {
    let (temp, host) = (data_with(&manifest(None)), FakeHost::default());
    let call = call(&temp, &host);
    for count in [json!(0), json!(2_147_483_647)] {
        assert!(put_chips(&call, json!([{ "count": count }])).is_ok());
    }
    for count in [
        json!(-1),
        json!(2_147_483_648u64),
        json!(1.5),
        json!("3"),
        json!(true),
    ] {
        assert_eq!(
            code(put_chips(&call, json!([{ "count": count.clone() }]))),
            ApiCode::InvalidArgs,
            "{count}"
        );
    }
}

#[test]
fn chip_text_and_tone_follow_the_rules() {
    let (temp, host) = (data_with(&manifest(None)), FakeHost::default());
    let call = call(&temp, &host);
    let emoji = "\u{1F600}";
    for unit in ["x", emoji] {
        let at_cap = put_chips(&call, json!([{ "text": unit.repeat(12) }]));
        assert!(at_cap.is_ok(), "{unit:?}");
        let over = put_chips(&call, json!([{ "text": unit.repeat(13) }]));
        assert_eq!(code(over), ApiCode::TooLarge, "{unit:?}");
    }
    for text in [
        json!(""),
        json!("  "),
        json!("a\nb"),
        json!("a\u{202E}"),
        json!(5),
    ] {
        let refused = put_chips(&call, json!([{ "text": text.clone() }]));
        assert_eq!(code(refused), ApiCode::InvalidArgs, "{text}");
    }
    for tone in ["neutral", "accent", "warn"] {
        assert!(put_chips(&call, json!([{ "count": 1, "tone": tone }])).is_ok());
    }
    for tone in [json!("danger"), json!(1), json!(["warn"])] {
        let refused = put_chips(&call, json!([{ "count": 1, "tone": tone.clone() }]));
        assert_eq!(code(refused), ApiCode::InvalidArgs, "{tone}");
    }
}

#[test]
fn a_third_chip_is_too_large_and_an_empty_list_clears() {
    let (temp, host) = (data_with(&manifest(None)), FakeHost::default());
    let call = call(&temp, &host);
    assert!(put_chips(&call, json!([{ "count": 1 }, { "count": 2 }])).is_ok());
    let three = json!([{ "count": 1 }, { "count": 2 }, { "count": 3 }]);
    assert_eq!(code(put_chips(&call, three)), ApiCode::TooLarge);
    // A refused call leaves the stored chips and sends nothing.
    assert_eq!(call.api.sidebar().snapshot(&call.enabled)[0].chips.len(), 2);
    assert_eq!(sidebar_events(&host).len(), 1);
    assert!(put_chips(&call, json!([])).is_ok());
    assert!(call.api.sidebar().snapshot(&call.enabled).is_empty());
    assert_eq!(
        sidebar_events(&host)[1],
        json!({ "id": ID, "kind": "chips", "chips": [] })
    );
    for bad in [json!(null), json!({}), json!("a")] {
        assert_eq!(code(put_chips(&call, bad)), ApiCode::InvalidArgs);
    }
    let missing = chips(&call.ctx(), &Map::new()).done();
    assert_eq!(code(missing), ApiCode::InvalidArgs);
}

// -- ui.sidebar.update: each type --

#[test]
fn a_nav_update_replaces_its_state_with_defaults() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let full =
        json!({ "label": "Library", "chip": { "count": 2, "tone": "warn" }, "visible": false });
    assert_eq!(put(&call, "home", full), Ok(json!({})));
    let events = sidebar_events(&host);
    assert_eq!(
        events[0],
        json!({ "id": ID, "kind": "item", "item_id": "home", "state": {
                "type": "nav", "visible": false, "label": "Library",
                "chip": { "text": null, "count": 2, "tone": "warn" } } })
    );
    // The next update names nothing, so every field returns to its default.
    put(&call, "home", json!({})).unwrap();
    assert_eq!(
        sidebar_events(&host)[1]["state"],
        json!({ "type": "nav", "visible": true, "label": null, "chip": null })
    );
    put(&call, "home", json!({ "label": null, "chip": null })).unwrap();
    assert_eq!(
        sidebar_events(&host)[2]["state"],
        sidebar_events(&host)[1]["state"]
    );
}

#[test]
fn a_status_update_needs_text() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    put(&call, "st", json!({ "text": "Scanning", "tone": "accent" })).unwrap();
    put(&call, "st", json!({ "text": "Done" })).unwrap();
    let events = sidebar_events(&host);
    assert_eq!(
        events[0]["state"],
        json!({ "type": "status", "visible": true, "tone": "accent", "text": "Scanning" })
    );
    assert_eq!(
        events[1]["state"],
        json!({ "type": "status", "visible": true, "tone": "neutral", "text": "Done" })
    );
    for state in [
        json!({}),
        json!({ "text": null }),
        json!({ "text": "" }),
        json!({ "text": 3 }),
        json!({ "text": "x", "tone": "loud" }),
        json!({ "text": "x", "visible": "yes" }),
    ] {
        assert_eq!(
            code(put(&call, "st", state.clone())),
            ApiCode::InvalidArgs,
            "{state}"
        );
    }
    assert_eq!(
        code(put(&call, "st", json!({ "text": "x".repeat(41) }))),
        ApiCode::TooLarge
    );
    assert!(put(&call, "st", json!({ "text": "x".repeat(40) })).is_ok());
}

#[test]
fn a_progress_update_takes_a_fraction_or_null() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    for value in [json!(0), json!(1), json!(0.5), json!(-0.0)] {
        assert!(put(&call, "pr", json!({ "value": value })).is_ok());
    }
    // -0 is stored as 0.
    assert_eq!(
        sidebar_events(&host)[3]["state"]["value"].to_string(),
        "0.0"
    );
    put(&call, "pr", json!({ "value": null, "text": "Working" })).unwrap();
    assert_eq!(
        sidebar_events(&host)[4]["state"],
        json!({ "type": "progress", "visible": true, "value": null, "text": "Working" })
    );
    for value in [
        json!(-0.01),
        json!(1.01),
        json!("0.5"),
        json!(true),
        json!([0]),
    ] {
        let refused = put(&call, "pr", json!({ "value": value.clone() }));
        assert_eq!(code(refused), ApiCode::InvalidArgs, "{value}");
    }
    // The value is required: leaving it out is not an indeterminate sweep.
    assert_eq!(code(put(&call, "pr", json!({}))), ApiCode::InvalidArgs);
    assert_eq!(
        code(put(
            &call,
            "pr",
            json!({ "value": 0.1, "text": "x".repeat(41) })
        )),
        ApiCode::TooLarge
    );
}

#[test]
fn a_non_finite_number_never_reaches_a_handler() {
    let temp = data_with(&manifest(Some(full_sidebar())));
    let host = FakeHost::default();
    let api = ApiState::default();
    let enabled = EnabledSet::only(
        ID,
        serving(
            Tier::Ui,
            vec![Capability::UiSidebar, Capability::Background],
        ),
    );
    for literal in ["NaN", "Infinity", "-Infinity", "1e999"] {
        let text = format!(r#"{{"item_id":"pr","state":{{"value":{literal}}}}}"#);
        let result = dispatch(
            &enabled,
            &api,
            ID,
            "ui.sidebar.update",
            &text,
            &temp.0,
            &host,
            Instant::now(),
        );
        assert_eq!(code(result), ApiCode::InvalidArgs, "{literal}");
    }
    assert!(sidebar_events(&host).is_empty());
}

#[test]
fn a_toggle_update_needs_on_and_defaults_enabled() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    put(
        &call,
        "tg",
        json!({ "on": true, "enabled": false, "visible": false }),
    )
    .unwrap();
    put(&call, "tg", json!({ "on": false })).unwrap();
    let events = sidebar_events(&host);
    assert_eq!(
        events[0]["state"],
        json!({ "type": "toggle", "visible": false, "on": true, "enabled": false })
    );
    assert_eq!(
        events[1]["state"],
        json!({ "type": "toggle", "visible": true, "on": false, "enabled": true })
    );
    for state in [
        json!({}),
        json!({ "on": "yes" }),
        json!({ "on": null }),
        json!({ "on": true, "enabled": 1 }),
    ] {
        assert_eq!(
            code(put(&call, "tg", state.clone())),
            ApiCode::InvalidArgs,
            "{state}"
        );
    }
}

#[test]
fn an_action_update_defaults_label_and_enabled() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    put(&call, "go", json!({ "label": "Stop", "enabled": false })).unwrap();
    put(&call, "go", json!({})).unwrap();
    let events = sidebar_events(&host);
    assert_eq!(
        events[0]["state"],
        json!({ "type": "action", "visible": true, "label": "Stop", "enabled": false })
    );
    assert_eq!(
        events[1]["state"],
        json!({ "type": "action", "visible": true, "label": null, "enabled": true })
    );
    assert_eq!(
        code(put(&call, "go", json!({ "label": "x".repeat(25) }))),
        ApiCode::TooLarge
    );
    assert_eq!(
        code(put(&call, "go", json!({ "label": "" }))),
        ApiCode::InvalidArgs
    );
}

#[test]
fn a_state_of_another_types_shape_is_refused() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let cases = [
        ("home", json!({ "on": true })),
        ("home", json!({ "text": "x" })),
        ("st", json!({ "text": "x", "on": true })),
        ("pr", json!({ "value": 0.5, "enabled": true })),
        ("tg", json!({ "on": true, "label": "x" })),
        ("go", json!({ "on": true })),
        ("go", json!({ "value": 1 })),
    ];
    for (item, state) in cases {
        assert_eq!(
            code(put(&call, item, state.clone())),
            ApiCode::InvalidArgs,
            "{item} {state}"
        );
    }
    // Unknown names stay ignored.
    assert!(put(&call, "go", json!({ "badge": 1 })).is_ok());
    assert!(sidebar_events(&host).len() == 1);
}

#[test]
fn arguments_must_have_the_right_types() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let ctx = call.ctx();
    for given in [
        json!({}),
        json!({ "item_id": "st" }),
        json!({ "state": {} }),
        json!({ "item_id": 5, "state": {} }),
        json!({ "item_id": "st", "state": "text" }),
        json!({ "item_id": "st", "state": null }),
        json!({ "item_id": "st", "state": [] }),
    ] {
        assert_eq!(
            code(update(&ctx, &args(given.clone())).done()),
            ApiCode::InvalidArgs,
            "{given}"
        );
    }
}

// -- ui.sidebar.update: what is declared --

#[test]
fn an_undeclared_item_is_not_found() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    for item in ["nope", "", "ST", "home "] {
        assert_eq!(
            code(put(&call, item, json!({ "text": "x" }))),
            ApiCode::NotFound,
            "{item:?}"
        );
    }
    assert!(sidebar_events(&host).is_empty());
    assert!(call.api.sidebar().snapshot(&call.enabled).is_empty());
}

#[test]
fn a_plugin_with_no_sidebar_block_is_not_found() {
    let (temp, host) = (data_with(&manifest(None)), FakeHost::default());
    let call = call(&temp, &host);
    assert_eq!(
        code(put(&call, "st", json!({ "text": "x" }))),
        ApiCode::NotFound
    );
    assert_eq!(
        code(put(&call, "st", json!({ "text": "x" }))),
        ApiCode::NotFound
    );
}

#[test]
fn an_unreadable_manifest_is_unavailable() {
    let temp = Temp::new("sidebar");
    let host = FakeHost::default();
    let call = call(&temp, &host);
    assert_eq!(
        code(put(&call, "st", json!({ "text": "x" }))),
        ApiCode::Unavailable
    );
    let dir = plugin_dir(&temp.0, ID);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), "{ not json").unwrap();
    assert_eq!(
        code(put(&call, "st", json!({ "text": "x" }))),
        ApiCode::Unavailable
    );
    // Chips need no declaration.
    assert!(put_chips(&call, json!([{ "count": 1 }])).is_ok());
}

#[test]
fn the_declaration_is_cached_per_version() {
    let temp = data_with(&manifest(Some(full_sidebar())));
    let api = ApiState::default();
    let read = |version: &str| declaration(&api, &temp.0, ID, version).unwrap();
    assert_eq!(read("1.0.0").items.len(), 5);
    let narrower = json!({ "layout": "compact", "items": [
            { "id": "st", "type": "status", "label": "Idle" } ] });
    fs::write(
        plugin_dir(&temp.0, ID).join("plugin.json"),
        manifest(Some(narrower)),
    )
    .unwrap();
    // The same version answers from the cache; a new version reads the manifest again.
    assert_eq!(read("1.0.0").items.len(), 5);
    assert_eq!(read("1.0.1").items.len(), 1);
    assert_eq!(read("1.0.1").layout, Layout::Compact);
    // Forgetting drops the cache.
    api.sidebar().forget(ID);
    assert_eq!(read("1.0.0").items.len(), 1);
}

#[test]
fn a_plugin_withdrawn_mid_call_leaves_no_state() {
    let temp = data_with(&manifest(Some(full_sidebar())));
    let host = FakeHost::default();
    let mut call = call(&temp, &host);
    call.enabled = EnabledSet::only(OTHER, serving(Tier::Ui, Vec::new()));
    assert_eq!(
        code(put(&call, "st", json!({ "text": "x" }))),
        ApiCode::Unavailable
    );
    assert!(sidebar_events(&host).is_empty());
    assert!(call
        .api
        .sidebar()
        .snapshot(&EnabledSet::only(ID, serving(Tier::Ui, Vec::new())))
        .is_empty());
}

#[test]
fn chips_set_by_a_withdrawn_plugin_are_not_there_when_it_serves_again() {
    let temp = data_with(&manifest(Some(full_sidebar())));
    let host = FakeHost::default();
    let mut call = call(&temp, &host);
    let serving_id = EnabledSet::only(ID, serving(Tier::Ui, Vec::new()));
    call.enabled = EnabledSet::only(OTHER, serving(Tier::Ui, Vec::new()));
    assert_eq!(
        code(put_chips(&call, json!([{ "count": 1 }]))),
        ApiCode::Unavailable
    );
    assert!(sidebar_events(&host).is_empty());
    assert!(call.api.sidebar().snapshot(&serving_id).is_empty());
}

// -- Store --

#[test]
fn forget_drops_chips_items_and_the_declaration() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    put(&call, "st", json!({ "text": "x" })).unwrap();
    put_chips(&call, json!([{ "count": 1 }])).unwrap();
    assert_eq!(call.api.sidebar().snapshot(&call.enabled).len(), 1);
    call.api.forget(ID);
    assert!(call.api.sidebar().snapshot(&call.enabled).is_empty());
    assert!(call.api.sidebar().cached(ID, "1.0.0").is_none());
}

#[test]
fn a_snapshot_lists_only_serving_plugins_with_state() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let store = call.api.sidebar();
    store.set_chips(
        OTHER,
        vec![Chip {
            text: Some("a".into()),
            count: None,
            tone: Tone::Neutral,
        }],
    );
    store.set_chips("com.example.zed", Vec::new());
    put(&call, "tg", json!({ "on": true })).unwrap();
    put(&call, "st", json!({ "text": "x" })).unwrap();
    let serving_both = EnabledSet::only(ID, serving(Tier::Ui, Vec::new()));
    let snapshot = store.snapshot(&serving_both);
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].id, ID);
    // Items are listed by id.
    let ids: Vec<&str> = snapshot[0]
        .items
        .iter()
        .map(|e| e.item_id.as_str())
        .collect();
    assert_eq!(ids, ["st", "tg"]);
    assert!(store
        .snapshot(&EnabledSet::only(
            "com.example.none",
            serving(Tier::Ui, Vec::new())
        ))
        .is_empty());
    assert_eq!(
        serde_json::to_value(&snapshot[0]).unwrap(),
        json!({ "id": ID, "chips": [], "items": [
                { "item_id": "st", "state": { "type": "status", "visible": true, "tone": "neutral", "text": "x" } },
                { "item_id": "tg", "state": { "type": "toggle", "visible": true, "on": true, "enabled": true } } ] })
    );
}

// -- check_input --

fn input(call: &TestCall<'_>, item: &str, value: Option<bool>, now: Instant) -> SidebarInputReply {
    check_input(
        &call.api,
        &call.enabled,
        call.app_data,
        ID,
        item,
        value,
        now,
    )
}

#[test]
fn a_toggle_needs_a_value_and_an_action_needs_none() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    // Each click is a fifth of a second apart, so the burst limit never applies.
    let t0 = Instant::now();
    let tick = std::cell::Cell::new(0u64);
    let now = || {
        tick.set(tick.get() + 1);
        t0 + std::time::Duration::from_millis(200 * tick.get())
    };
    let reply = input(&call, "tg", Some(true), now());
    assert!(reply.accepted);
    let frame = reply.frame.unwrap();
    assert_eq!((frame.item_id.as_str(), frame.value), ("tg", Some(true)));
    assert!(input(&call, "tg", Some(false), now()).accepted);
    assert!(!input(&call, "tg", None, now()).accepted);
    let reply = input(&call, "go", None, now());
    assert!(reply.accepted);
    assert_eq!(reply.frame.unwrap().value, None);
    assert!(!input(&call, "go", Some(true), now()).accepted);
    assert_eq!(
        serde_json::to_value(input(&call, "tg", Some(true), now()).frame.unwrap()).unwrap()
            ["item_id"],
        "tg"
    );
}

#[test]
fn nav_status_progress_and_undeclared_items_are_refused() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    // Each click is a fifth of a second apart, so the burst limit never applies.
    let t0 = Instant::now();
    let tick = std::cell::Cell::new(0u64);
    let now = || {
        tick.set(tick.get() + 1);
        t0 + std::time::Duration::from_millis(200 * tick.get())
    };
    for item in ["home", "st", "pr", "nope", ""] {
        for value in [None, Some(true), Some(false)] {
            let reply = input(&call, item, value, now());
            assert!(
                !reply.accepted && reply.frame.is_none(),
                "{item:?} {value:?}"
            );
        }
    }
    // None of the refusals above passed the declaration and fit checks, so none minted a token.
    assert!(input(&call, "go", None, now()).accepted);
}

#[test]
fn the_sixth_click_in_a_burst_is_refused() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let t0 = Instant::now();
    for n in 0..5 {
        assert!(input(&call, "go", None, t0).accepted, "click {n}");
    }
    let sixth = input(&call, "go", None, t0);
    assert!(!sixth.accepted && sixth.frame.is_none());
    let later = t0 + std::time::Duration::from_millis(200);
    assert!(input(&call, "go", None, later).accepted);
}

#[test]
fn a_click_spends_the_input_bucket_and_never_the_all_bucket() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let t0 = Instant::now();
    for _ in 0..5 {
        assert!(input(&call, "go", None, t0).accepted);
    }
    // The `all` bucket still holds its 100 tokens.
    for _ in 0..100 {
        assert!(call.api.take_all(ID, t0).is_ok());
    }
    assert!(call.api.take_all(ID, t0).is_err());
}

#[test]
fn an_accepted_click_mints_a_gesture_bound_to_the_plugin() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let now = Instant::now();
    let token = input(&call, "go", None, now).frame.unwrap().gesture;
    assert!(token.starts_with("g1."));
    assert!(!call.api.ui().consume(OTHER, &token, now));
    assert!(call.api.ui().consume(ID, &token, now));
    assert!(!call.api.ui().consume(ID, &token, now));
    // A refused click mints nothing: only the one accepted token existed.
    assert!(!input(&call, "st", None, now).accepted);
}

#[test]
fn a_click_from_a_plugin_that_is_not_serving_is_refused_and_a_native_one_is_taken() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let mut call = call(&temp, &host);
    let now = Instant::now();
    call.enabled = EnabledSet::only(ID, serving(Tier::Native, Vec::new()));
    let token = input(&call, "go", None, now).frame.unwrap().gesture;
    assert!(call.api.ui().consume(ID, &token, now));
    call.enabled = EnabledSet::only(OTHER, serving(Tier::Ui, Vec::new()));
    assert!(!input(&call, "go", None, now).accepted);
    // A manifest that cannot be read refuses too.
    let bare = Temp::new("sidebar");
    let missing = test_ctx(&bare.0, &host);
    assert!(!input(&missing, "go", None, now).accepted);
}

// -- Through the dispatch table --

#[test]
fn the_methods_are_in_the_table_and_need_their_capabilities() {
    let names = method_names();
    for name in ["ui.chips", "ui.sidebar.update"] {
        assert!(names.contains(&name), "{name}");
    }
    let api = ApiState::default();
    let t0 = Instant::now();
    let bare = EnabledSet::only(ID, serving(Tier::Ui, Vec::new()));
    for method in ["ui.chips", "ui.sidebar.update"] {
        let refused = admit(&bare, &api, ID, method, 2, t0);
        assert_eq!(code(refused.map(|_| ())), ApiCode::Denied, "{method}");
    }
    let chips_only = EnabledSet::only(ID, serving(Tier::Ui, vec![Capability::UiChips]));
    assert!(admit(&chips_only, &api, ID, "ui.chips", 2, t0).is_ok());
    let refused = admit(&chips_only, &api, ID, "ui.sidebar.update", 2, t0);
    assert_eq!(code(refused.map(|_| ())), ApiCode::Denied);
}

#[test]
fn updates_are_rate_limited_per_class() {
    let temp = data_with(&manifest(Some(full_sidebar())));
    let host = FakeHost::default();
    let api = ApiState::default();
    let granted = vec![Capability::UiChips, Capability::UiSidebar];
    let enabled = EnabledSet::only(ID, serving(Tier::Ui, granted));
    let t0 = Instant::now();
    let send = |method: &str, text: &str, now: Instant| {
        dispatch(&enabled, &api, ID, method, text, &temp.0, &host, now)
    };
    let update = r#"{"item_id":"st","state":{"text":"x"}}"#;
    for _ in 0..20 {
        assert_eq!(send("ui.sidebar.update", update, t0), Ok(json!({})));
    }
    let limited = send("ui.sidebar.update", update, t0).unwrap_err();
    assert_eq!(limited.code, ApiCode::RateLimited);
    // The chips bucket is separate: 10 pass, the 11th is limited.
    for _ in 0..10 {
        assert_eq!(send("ui.chips", r#"{"chips":[]}"#, t0), Ok(json!({})));
    }
    let limited = send("ui.chips", r#"{"chips":[]}"#, t0).unwrap_err();
    assert_eq!(limited.code, ApiCode::RateLimited);
}

#[test]
fn plugin_text_stays_out_of_error_messages() {
    let (temp, host) = (
        data_with(&manifest(Some(full_sidebar()))),
        FakeHost::default(),
    );
    let call = call(&temp, &host);
    let secret = "SECRET-LABEL\u{202E}";
    let refused = put(&call, "go", json!({ "label": secret })).unwrap_err();
    assert!(!refused.message.contains("SECRET"));
    let refused = put(&call, "SECRET-ITEM", json!({})).unwrap_err();
    assert!(!refused.message.contains("SECRET"));
}
