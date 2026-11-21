// Settings and presets of a visualizer kind: the four control types, their defaults, and refusals.

// -- Library Imports --
use serde_json::{json, Value};

// -- Local Imports --
use super::*;
use crate::plugins::visualizer_decl::settings::{SettingKind, SettingValue};

fn with_settings(settings: Value) -> Value {
    with_kind("settings", settings)
}

fn with_presets(settings: Value, presets: Value) -> Value {
    let mut k = kind();
    k["settings"] = settings;
    k["presets"] = presets;
    manifest(&["visualizer"], json!([k]))
}

fn layout() -> Value {
    json!({ "id": "layout", "label": "Layout", "type": "choice",
            "options": [{ "id": "left", "label": "Bass left" },
                        { "id": "mirrored", "label": "Mirrored" }] })
}

fn tint() -> Value {
    json!({ "id": "tint", "label": "Tint", "type": "color", "default": "cover" })
}

fn settings_of(v: &Value) -> Vec<SettingDecl> {
    run(v).unwrap().remove(0).settings
}

#[test]
fn every_setting_type_parses_with_its_default() {
    let settings = settings_of(&with_settings(json!([
        layout(),
        { "id": "spin", "label": "Spin", "type": "toggle", "default": true },
        { "id": "size", "label": "Size", "type": "range", "min": 0.5, "max": 2, "step": 0.1 },
        tint()
    ])));
    assert_eq!(settings.len(), 4);
    assert_eq!(settings[0].default, SettingValue::Text("left".into()));
    assert_eq!(settings[1].kind, SettingKind::Toggle);
    assert_eq!(settings[1].default, SettingValue::Flag(true));
    assert_eq!(
        settings[2].kind,
        SettingKind::Range { min: 0.5, max: 2.0, step: 0.1 }
    );
    assert_eq!(settings[2].default, SettingValue::Number(0.5));
    assert_eq!(settings[3].default, SettingValue::Text("cover".into()));
}

#[test]
fn a_setting_serializes_flat_with_its_type() {
    let settings = settings_of(&with_settings(json!([
        layout(),
        { "id": "spin", "label": "Spin", "type": "toggle", "default": true },
        { "id": "size", "label": "Size", "type": "range", "min": 0.5, "max": 2, "step": 0.25 },
        tint()
    ])));
    assert_eq!(
        serde_json::to_value(&settings).unwrap(),
        json!([
            { "id": "layout", "label": "Layout", "type": "choice", "default": "left",
              "options": [{ "id": "left", "label": "Bass left" },
                          { "id": "mirrored", "label": "Mirrored" }] },
            { "id": "spin", "label": "Spin", "type": "toggle", "default": true },
            { "id": "size", "label": "Size", "type": "range", "default": 0.5,
              "min": 0.5, "max": 2.0, "step": 0.25 },
            { "id": "tint", "label": "Tint", "type": "color", "default": "cover" }
        ])
    );
}

#[test]
fn a_default_must_be_a_value_the_setting_takes() {
    for (setting, default) in [
        (layout(), json!("right")),
        (tint(), json!("blue")),
        (tint(), json!("#12345")),
        (json!({ "id": "on", "label": "On", "type": "toggle" }), json!("yes")),
        (
            json!({ "id": "n", "label": "N", "type": "range", "min": 0, "max": 1, "step": 0.5 }),
            json!(2),
        ),
    ] {
        let mut s = setting;
        s["default"] = default;
        let field = field_refusal(&with_settings(json!([s])));
        assert!(field.ends_with(".default"), "{field}");
    }
    let mut hex = tint();
    hex["default"] = json!("#3A6ea5");
    assert!(run(&with_settings(json!([hex]))).is_ok());
}

#[test]
fn choice_options_are_bounded_and_unique() {
    let mut one = layout();
    one["options"] = json!([{ "id": "left", "label": "Left" }]);
    assert_eq!(field_refusal(&with_settings(json!([one]))), "settings.layout.options");
    let mut nine = layout();
    nine["options"] = json!((0..9)
        .map(|i| json!({ "id": format!("o{i}"), "label": "O" }))
        .collect::<Vec<_>>());
    assert_eq!(field_refusal(&with_settings(json!([nine]))), "settings.layout.options");
    let mut twice = layout();
    twice["options"] = json!([{ "id": "a", "label": "A" }, { "id": "a", "label": "B" }]);
    assert_eq!(field_refusal(&with_settings(json!([twice]))), "settings.layout.options.2.a");
}

#[test]
fn fields_of_another_type_reject() {
    let mut toggle = json!({ "id": "on", "label": "On", "type": "toggle" });
    toggle["options"] = layout()["options"].clone();
    assert_eq!(field_refusal(&with_settings(json!([toggle]))), "settings.on.options");
    let mut color = tint();
    color["min"] = json!(0);
    assert_eq!(field_refusal(&with_settings(json!([color]))), "settings.tint");
}

#[test]
fn a_range_must_be_well_formed() {
    let range = |min: f64, max: f64, step: f64| {
        json!({ "id": "n", "label": "N", "type": "range", "min": min, "max": max, "step": step })
    };
    assert_eq!(field_refusal(&with_settings(json!([range(1.0, 1.0, 0.1)]))), "settings.n.min");
    assert_eq!(field_refusal(&with_settings(json!([range(0.0, 1.0, 0.0)]))), "settings.n.step");
    assert_eq!(field_refusal(&with_settings(json!([range(0.0, 1.0, 2.0)]))), "settings.n.step");
    let no_step = json!({ "id": "n", "label": "N", "type": "range", "min": 0, "max": 1 });
    assert_eq!(field_refusal(&with_settings(json!([no_step]))), "settings.n");
}

#[test]
fn setting_ids_labels_and_types_are_checked() {
    let mut s = tint();
    s["type"] = json!("slider");
    assert_eq!(field_refusal(&with_settings(json!([s]))), "settings.tint.type");
    let mut s = tint();
    s["label"] = json!("l".repeat(25));
    assert_eq!(field_refusal(&with_settings(json!([s]))), "settings.tint.label");
    let mut s = tint();
    s["id"] = json!("Tint");
    assert_eq!(field_refusal(&with_settings(json!([s]))), "settings.1.id");
    assert_eq!(field_refusal(&with_settings(json!([tint(), tint()]))), "settings.2.tint");
}

#[test]
fn settings_and_presets_are_capped() {
    let nine: Vec<Value> = (0..9)
        .map(|i| json!({ "id": format!("s{i}"), "label": "S", "type": "toggle" }))
        .collect();
    let e = refusal(&with_settings(json!(nine)));
    assert!(matches!(e, VisualizerError::TooMany { field: "settings", max: 8, .. }));
    let seven: Vec<Value> = (0..7)
        .map(|i| json!({ "id": format!("p{i}"), "label": "P", "values": { "tint": "cover" } }))
        .collect();
    let e = refusal(&with_presets(json!([tint()]), json!(seven)));
    assert!(matches!(e, VisualizerError::TooMany { field: "presets", max: 6, .. }));
}

#[test]
fn a_preset_bundles_values_its_settings_take() {
    let presets = run(&with_presets(
        json!([layout(), tint()]),
        json!([{ "id": "calm-blue", "label": "Calm blue",
                 "values": { "tint": "#3a6ea5", "layout": "mirrored" } }]),
    ))
    .unwrap()
    .remove(0)
    .presets;
    assert_eq!(presets[0].id, "calm-blue");
    assert_eq!(presets[0].values["tint"], SettingValue::Text("#3a6ea5".into()));
    assert_eq!(presets[0].values["layout"], SettingValue::Text("mirrored".into()));
}

#[test]
fn a_bad_preset_rejects() {
    let preset = |values: Value| json!([{ "id": "p", "label": "P", "values": values }]);
    let cases = [
        (preset(json!({ "size": 1 })), "presets.p.values.size"),
        (preset(json!({ "tint": "blue" })), "presets.p.values.tint"),
        (preset(json!({})), "presets.p.values"),
        (json!([{ "id": "p", "label": "P" }]), "presets.p.values"),
        (json!([{ "id": "p", "values": { "tint": "cover" } }]), "presets.p.label"),
    ];
    for (presets, field) in cases {
        assert_eq!(field_refusal(&with_presets(json!([tint()]), presets)), field);
    }
}
