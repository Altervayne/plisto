// The visualizers block, case by case: what is accepted, the error each refusal carries, and the
// broken state an installed plugin falls into when a file a visualizer names goes missing.

// -- Library Imports --
use std::fs;

use serde_json::{json, Value};

// -- Local Imports --
use crate::plugins::install::inspect;
use crate::plugins::install_error::ErrorCode;
use crate::plugins::manifest::{parse, ManifestError};
use crate::plugins::paths::plugin_dir;
use crate::plugins::registry::EntryState;
use crate::plugins::stage::Limits;
use crate::plugins::test_kit::{Kit, ID};

use super::*;

fn kind() -> Value {
    json!({ "id": "rings", "name": "Rings", "api": 1, "page": "vis/rings.html", "look": "glow" })
}

fn manifest(caps: &[&str], kinds: Value) -> Value {
    json!({
        "manifest_version": 1, "id": "com.example.vis", "name": "Vis", "version": "1.0.0",
        "tier": "ui", "capabilities": caps, "min_plisto": "1.0.0", "author": "A",
        "visualizers": kinds
    })
}

fn run(v: &Value) -> Result<Vec<VisualizerDecl>, ManifestError> {
    parse(v.to_string().as_bytes()).map(|m| m.visualizers)
}

fn with_kind(key: &str, val: Value) -> Value {
    let mut k = kind();
    k[key] = val;
    manifest(&["visualizer"], json!([k]))
}

fn refusal(v: &Value) -> VisualizerError {
    match run(v) {
        Err(ManifestError::Visualizer(e)) => e,
        other => panic!("expected a visualizer refusal, got {other:?}"),
    }
}

fn field_refusal(v: &Value) -> String {
    match refusal(v) {
        VisualizerError::Field { field, .. } => field,
        other => panic!("expected a field refusal, got {other:?}"),
    }
}

#[test]
fn a_minimal_kind_parses_with_defaults() {
    let decls = run(&manifest(&["visualizer"], json!([kind()]))).unwrap();
    assert_eq!(decls.len(), 1);
    let d = &decls[0];
    assert_eq!(d.id, "rings");
    assert_eq!(d.page.as_deref(), Some("vis/rings.html"));
    assert_eq!(d.shader, None);
    assert!(!d.fills_stage && !d.dark_only);
    assert_eq!(d.needs, Needs::default());
    assert!(d.aliases.is_empty() && d.settings.is_empty() && d.presets.is_empty());
}

#[test]
fn the_look_shorthands_expand_and_a_pair_is_kept() {
    let glow = &run(&with_kind("look", json!("glow"))).unwrap()[0].look;
    assert_eq!(glow.light.composite, Composite::Ink);
    assert_eq!(glow.light.blend, "multiply");
    assert_eq!(glow.dark.composite, Composite::Light);
    assert_eq!(glow.dark.blend, "screen");
    let image = &run(&with_kind("look", json!("image"))).unwrap()[0].look;
    assert_eq!(image.light, image.dark);
    assert_eq!(image.light.composite, Composite::Image);
    let pair = json!({ "light": { "composite": "image", "blend": "darken" },
                       "dark": { "composite": "light", "blend": "plus-lighter" } });
    let look = &run(&with_kind("look", pair)).unwrap()[0].look;
    assert_eq!(look.light.blend, "darken");
    assert_eq!(look.dark.composite, Composite::Light);
}

#[test]
fn a_bad_look_rejects() {
    for look in [
        json!("neon"),
        json!(3),
        json!({ "light": { "composite": "ink", "blend": "multiply" } }),
        json!({ "light": { "composite": "glow", "blend": "multiply" },
                "dark": { "composite": "light", "blend": "screen" } }),
        json!({ "light": { "composite": "ink", "blend": "url(x)" },
                "dark": { "composite": "light", "blend": "screen" } }),
    ] {
        assert_eq!(field_refusal(&with_kind("look", look.clone())), "look", "{look}");
    }
}

#[test]
fn a_shader_kind_parses() {
    let mut k = kind();
    k.as_object_mut().unwrap().remove("page");
    k["shader"] = json!("vis/glow.frag");
    let decls = run(&manifest(&["visualizer"], json!([k]))).unwrap();
    assert_eq!(decls[0].shader.as_deref(), Some("vis/glow.frag"));
    assert_eq!(decls[0].page, None);
}

#[test]
fn a_kind_needs_exactly_one_source() {
    let mut both = kind();
    both["shader"] = json!("vis/glow.frag");
    let mut neither = kind();
    neither.as_object_mut().unwrap().remove("page");
    for k in [both, neither] {
        let e = refusal(&manifest(&["visualizer"], json!([k])));
        assert_eq!(e, VisualizerError::Source("rings".into()));
    }
}

#[test]
fn bad_sources_reject() {
    assert_eq!(field_refusal(&with_kind("page", json!("vis/rings.js"))), "page");
    assert_eq!(field_refusal(&with_kind("page", json!("../rings.html"))), "page");
    let mut k = kind();
    k.as_object_mut().unwrap().remove("page");
    k["shader"] = json!("vis/glow.html");
    assert_eq!(field_refusal(&manifest(&["visualizer"], json!([k]))), "shader");
}

#[test]
fn the_block_and_the_capability_come_together() {
    assert_eq!(
        refusal(&manifest(&["storage"], json!([kind()]))),
        VisualizerError::NeedsCapability
    );
    let mut no_block = manifest(&["visualizer"], json!([]));
    no_block.as_object_mut().unwrap().remove("visualizers");
    no_block["entry"] = json!("index.html");
    assert_eq!(refusal(&no_block), VisualizerError::NoVisualizers);
    assert_eq!(
        refusal(&manifest(&["visualizer.waveform"], json!([kind()]))),
        VisualizerError::WaveformNeedsVisualizer
    );
}

#[test]
fn the_kind_count_is_bounded() {
    assert_eq!(refusal(&manifest(&["visualizer"], json!([]))), VisualizerError::Count(0));
    let nine: Vec<Value> = (0..9)
        .map(|i| {
            let mut k = kind();
            k["id"] = json!(format!("k{i}"));
            k
        })
        .collect();
    assert_eq!(refusal(&manifest(&["visualizer"], json!(nine))), VisualizerError::Count(9));
}

#[test]
fn missing_fields_reject() {
    for field in ["id", "name", "api", "look"] {
        let mut k = kind();
        k.as_object_mut().unwrap().remove(field);
        let e = refusal(&manifest(&["visualizer"], json!([k])));
        assert_eq!(e, VisualizerError::MissingField { index: 0, field }, "{field}");
    }
}

#[test]
fn bad_ids_reject() {
    for id in ["", "Rings", "rings_1", "a".repeat(25).as_str(), "r\u{e9}"] {
        let e = refusal(&with_kind("id", json!(id)));
        assert!(matches!(e, VisualizerError::BadId(_)), "{id}");
    }
    assert!(run(&with_kind("id", json!("a".repeat(24)))).is_ok());
}

#[test]
fn ids_and_aliases_share_one_namespace() {
    let mut other = kind();
    other["id"] = json!("waves");
    other["aliases"] = json!(["rings"]);
    let e = refusal(&manifest(&["visualizer"], json!([kind(), other])));
    assert_eq!(e, VisualizerError::DuplicateId("rings".into()));
    let e = refusal(&with_kind("aliases", json!(["old", "old"])));
    assert_eq!(e, VisualizerError::DuplicateId("old".into()));
}

#[test]
fn aliases_are_bounded_and_checked() {
    let e = refusal(&with_kind("aliases", json!(["a", "b", "c", "d", "e"])));
    assert!(matches!(e, VisualizerError::TooMany { field: "aliases", .. }));
    assert_eq!(field_refusal(&with_kind("aliases", json!(["Old"]))), "aliases.Old");
}

#[test]
fn only_api_one_is_accepted() {
    let e = refusal(&with_kind("api", json!(2)));
    assert_eq!(e, VisualizerError::UnsupportedApi { kind: "rings".into(), api: 2 });
}

#[test]
fn the_name_is_plain_text_up_to_24_characters() {
    assert!(run(&with_kind("name", json!("n".repeat(24)))).is_ok());
    for name in [json!("n".repeat(25)), json!(" "), json!("a\u{200B}b")] {
        assert_eq!(field_refusal(&with_kind("name", name.clone())), "name", "{name}");
    }
}

#[test]
fn the_waveform_needs_its_capability() {
    let k = with_kind("needs", json!({ "waveform": true }))["visualizers"].clone();
    assert_eq!(
        refusal(&manifest(&["visualizer"], k.clone())),
        VisualizerError::NeedsWaveform("rings".into())
    );
    let decls = run(&manifest(&["visualizer", "visualizer.waveform"], k)).unwrap();
    assert!(decls[0].needs.waveform);
    assert!(!decls[0].needs.cover);
}

#[test]
fn flags_parse() {
    let mut k = kind();
    k["fills_stage"] = json!(true);
    k["dark_only"] = json!(true);
    k["needs"] = json!({ "fine": true, "cover": true, "pointer": true });
    let d = &run(&manifest(&["visualizer"], json!([k]))).unwrap()[0];
    assert!(d.fills_stage && d.dark_only);
    assert!(d.needs.fine && d.needs.cover && d.needs.pointer && !d.needs.waveform);
}

#[test]
fn display_lines_are_single_lines() {
    let errors = [
        VisualizerError::NeedsCapability,
        VisualizerError::NoVisualizers,
        VisualizerError::WaveformNeedsVisualizer,
        VisualizerError::Count(9),
        VisualizerError::MissingField { index: 0, field: "id" },
        VisualizerError::BadId("X".into()),
        VisualizerError::DuplicateId("x".into()),
        VisualizerError::UnsupportedApi { kind: "x".into(), api: 2 },
        VisualizerError::Source("x".into()),
        VisualizerError::NeedsWaveform("x".into()),
        VisualizerError::TooMany { kind: "x".into(), field: "presets", max: 6 },
        bad("x", "look", "is wrong"),
    ];
    for e in errors {
        let line = ManifestError::Visualizer(e).to_string();
        assert!(!line.is_empty() && !line.contains('\n'), "{line}");
    }
}

// -- The entry --

#[test]
fn the_entry_is_optional_only_for_a_ui_plugin_with_visualizers_and_no_sidebar() {
    let m = parse(manifest(&["visualizer"], json!([kind()])).to_string().as_bytes()).unwrap();
    assert_eq!(m.entry, None);

    let mut with_entry = manifest(&["visualizer"], json!([kind()]));
    with_entry["entry"] = json!("index.html");
    let m = parse(with_entry.to_string().as_bytes()).unwrap();
    assert_eq!(m.entry.as_deref(), Some("index.html"));

    let mut sidebar = manifest(&["visualizer", "ui.sidebar"], json!([kind()]));
    sidebar["sidebar"] = json!({ "layout": "section",
        "items": [{ "id": "home", "type": "nav", "label": "Home" }] });
    assert_eq!(run(&sidebar), Err(ManifestError::MissingField("entry")));

    let mut native = manifest(&["visualizer"], json!([kind()]));
    native["tier"] = json!("native");
    native["native_reason"] = json!("Reads the audio stream in real time.");
    assert_eq!(run(&native), Err(ManifestError::MissingField("entry")));
    native["entry"] = json!("bin/tool.exe");
    assert_eq!(run(&native).unwrap().len(), 1);
}

#[test]
fn a_plain_ui_plugin_still_needs_its_entry() {
    let mut plain = manifest(&["storage"], json!([]));
    plain.as_object_mut().unwrap().remove("visualizers");
    assert_eq!(run(&plain), Err(ManifestError::MissingField("entry")));
}

// -- Files on disk --

#[test]
fn a_missing_visualizer_file_marks_the_plugin_broken() {
    let k = Kit::new();
    let mut m = manifest(&["visualizer"], json!([]));
    m["id"] = json!(ID);
    m["visualizers"] = json!([
        { "id": "rings", "name": "Rings", "api": 1, "page": "index.html", "look": "glow" }
    ]);
    k.install(&m);
    fs::remove_file(plugin_dir(&k.data, ID).join("index.html")).unwrap();
    let after = k.reboot();
    let row = after.rows().into_iter().find(|r| r.entry.id == ID).unwrap();
    assert_eq!(row.entry.state, EntryState::Broken);
    let problem = row.problem.unwrap();
    assert!(problem.contains("visualizer 'rings'"), "{problem}");
}

#[test]
fn an_install_refuses_a_missing_visualizer_file() {
    let k = Kit::new();
    let mut m = manifest(&["visualizer"], json!([kind()]));
    m["id"] = json!(ID);
    let src = k.source(&m, &[]);
    let refused = inspect(&k.data, &k.plugins, src.to_str().unwrap(), Limits::DEFAULT);
    assert_eq!(refused.unwrap_err().code, ErrorCode::MissingFile);
    fs::create_dir_all(src.join("vis")).unwrap();
    fs::write(src.join("vis/rings.html"), b"<p>").unwrap();
    assert_eq!(k.inspect_path(&src).visualizers.len(), 1);
}

#[test]
fn check_files_names_the_kind_and_field() {
    let k = Kit::new();
    let dir = k.data.join("vis-files");
    fs::create_dir_all(dir.join("vis")).unwrap();
    fs::write(dir.join("vis/rings.html"), b"<p>").unwrap();
    let mut shader = kind();
    shader["id"] = json!("glow");
    shader.as_object_mut().unwrap().remove("page");
    shader["shader"] = json!("vis/glow.frag");
    let decls = run(&manifest(&["visualizer"], json!([kind(), shader]))).unwrap();
    let missing = check_files(&dir, &decls).unwrap_err();
    assert_eq!(missing, MissingFile { kind: "glow".into(), field: "shader" });
    fs::write(dir.join("vis/glow.frag"), b"void main() {}").unwrap();
    assert_eq!(check_files(&dir, &decls), Ok(()));
}

mod settings;
