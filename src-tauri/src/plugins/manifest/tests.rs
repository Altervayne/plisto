// Manifest parsing and validation, case by case: what is accepted, and the error each refusal carries.

// -- Library Imports --
use serde_json::{json, Value};

// -- Local Imports --
use super::*;

fn ui() -> Value {
    json!({
        "manifest_version": 1,
        "id": "com.example.demo",
        "name": "Demo",
        "version": "1.0.0",
        "tier": "ui",
        "entry": "index.html",
        "capabilities": ["storage"],
        "min_plisto": "2.0.0",
        "author": "Someone"
    })
}

fn native() -> Value {
    let mut v = ui();
    v["tier"] = json!("native");
    v["entry"] = json!("bin/tool.exe");
    v["native_reason"] = json!("Needs to read the audio stream in real time.");
    v
}

fn run(v: &Value) -> Result<Manifest, ManifestError> {
    parse(v.to_string().as_bytes())
}

fn with(mut v: Value, key: &str, val: Value) -> Value {
    v[key] = val;
    v
}

fn without(mut v: Value, key: &str) -> Value {
    v.as_object_mut().unwrap().remove(key);
    v
}

#[test]
fn minimal_ui_manifest_parses() {
    let m = run(&ui()).unwrap();
    assert_eq!(m.id, "com.example.demo");
    assert_eq!(m.tier, Tier::Ui);
    assert_eq!(m.capabilities, vec![Capability::Storage]);
    assert_eq!(m.modes, vec![ModeOpt::Player]);
    assert!(m.network.is_empty());
    assert!(m.sidebar.is_none());
    assert_eq!(m.compat, Compat::Compatible);
}

#[test]
fn minimal_native_manifest_parses() {
    let m = run(&native()).unwrap();
    assert_eq!(m.tier, Tier::Native);
    assert!(m.native_reason.is_some());
}

#[test]
fn full_manifest_parses() {
    let v = json!({
        "manifest_version": 1, "id": "com.example.full", "name": "Full", "version": "1.2.3-beta.1+b5",
        "tier": "ui", "entry": "ui/app.HTML",
        "capabilities": ["storage", "library.read", "playback.read", "playback.control", "network",
            "background", "ui.toast", "ui.confirm", "ui.chips", "ui.sidebar"],
        "min_plisto": "2.6.0", "author": "A", "homepage": "https://example.com/x",
        "icon": "assets/icon.svg", "modes": ["player", "organizer"],
        "network": ["https://api.example.com", "https://cdn.example.com:8443"],
        "sidebar": { "layout": "section", "items": [
            { "id": "home", "type": "nav", "label": "Home", "icon": "music", "route": "/home" },
            { "id": "st", "type": "status", "label": "Idle" } ] }
    });
    let m = run(&v).unwrap();
    assert_eq!(m.capabilities.len(), 10);
    assert_eq!(m.modes, vec![ModeOpt::Player, ModeOpt::Organizer]);
    assert_eq!(m.network.len(), 2);
    assert_eq!(m.sidebar.unwrap().items.len(), 2);
}

#[test]
fn unknown_fields_are_ignored() {
    let v = with(
        with(ui(), "future_field", json!({ "a": 1 })),
        "x",
        json!([1, 2]),
    );
    assert!(run(&v).is_ok());
}

#[test]
fn utf8_bom_is_tolerated() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(ui().to_string().as_bytes());
    assert!(parse(&bytes).is_ok());
}

#[test]
fn oversize_rejects() {
    let v = with(ui(), "name", json!("x".repeat(MAX_MANIFEST_BYTES)));
    assert!(matches!(run(&v), Err(ManifestError::TooLarge(_))));
    let exact = vec![b' '; MAX_MANIFEST_BYTES + 1];
    assert!(matches!(parse(&exact), Err(ManifestError::TooLarge(_))));
}

#[test]
fn malformed_json_rejects() {
    for bytes in [&b"not json"[..], b"", b"[1,2]", b"{\"id\":", b"\xff\xfe"] {
        assert!(
            matches!(parse(bytes), Err(ManifestError::Malformed(_))),
            "{bytes:?}"
        );
    }
}

#[test]
fn duplicate_keys_reject() {
    let raw = r#"{"manifest_version":1,"manifest_version":1}"#;
    assert!(matches!(
        parse(raw.as_bytes()),
        Err(ManifestError::Malformed(_))
    ));
}

#[test]
fn wrong_field_type_rejects() {
    for v in [
        with(ui(), "name", json!(5)),
        with(ui(), "capabilities", json!("storage")),
    ] {
        assert!(matches!(run(&v), Err(ManifestError::Malformed(_))));
    }
}

#[test]
fn missing_required_fields_reject() {
    for field in [
        "manifest_version",
        "id",
        "name",
        "version",
        "tier",
        "entry",
        "capabilities",
        "min_plisto",
        "author",
    ] {
        assert_eq!(
            run(&without(ui(), field)),
            Err(ManifestError::MissingField(field)),
            "{field}"
        );
    }
}

#[test]
fn unsupported_manifest_version_rejects() {
    for n in [0u64, 2] {
        assert_eq!(
            run(&with(ui(), "manifest_version", json!(n))),
            Err(ManifestError::UnsupportedManifestVersion(n))
        );
    }
}

#[test]
fn bad_id_rejects() {
    for id in [
        "",
        "demo",
        "Com.Example.Demo",
        "com.example.new",
        "con.example",
    ] {
        assert!(
            matches!(
                run(&with(ui(), "id", json!(id))),
                Err(ManifestError::BadId(_))
            ),
            "{id}"
        );
    }
}

#[test]
fn name_and_author_rules() {
    for field in ["name", "author"] {
        let max = if field == "name" {
            MAX_NAME
        } else {
            MAX_AUTHOR
        };
        assert!(run(&with(ui(), field, json!("x".repeat(max)))).is_ok());
        assert!(matches!(
            run(&with(ui(), field, json!("x".repeat(max + 1)))),
            Err(ManifestError::FieldTooLong { .. })
        ));
        assert!(matches!(
            run(&with(ui(), field, json!("  "))),
            Err(ManifestError::EmptyField(_))
        ));
        assert!(matches!(
            run(&with(ui(), field, json!("a\u{7}b"))),
            Err(ManifestError::ControlChars(_))
        ));
    }
}

#[test]
fn a_name_or_author_with_surrounding_whitespace_is_refused() {
    for field in ["name", "author"] {
        for padded in ["A ", " A", "\u{a0}A", "A\u{3000}"] {
            assert_eq!(
                run(&with(ui(), field, json!(padded))),
                Err(ManifestError::PaddedField(field)),
                "{field} {padded:?}"
            );
        }
        assert!(run(&with(ui(), field, json!("A B"))).is_ok(), "{field}");
    }
}

#[test]
fn bad_version_rejects() {
    for v in [
        "",
        "1",
        "1.0",
        "1.0.0.0",
        "01.0.0",
        "1.0.x",
        "v1.0.0",
        "1.0.0-",
        "1.0.0-01",
        "1.0.0+",
        "1.0.0-a..b",
    ] {
        assert!(
            matches!(
                run(&with(ui(), "version", json!(v))),
                Err(ManifestError::BadVersion {
                    field: "version",
                    ..
                })
            ),
            "{v:?}"
        );
        assert!(
            matches!(
                run(&with(ui(), "min_plisto", json!(v))),
                Err(ManifestError::BadVersion {
                    field: "min_plisto",
                    ..
                })
            ),
            "{v:?}"
        );
    }
    let long = format!("1.0.0-{}", "a".repeat(40));
    assert!(matches!(
        run(&with(ui(), "version", json!(long))),
        Err(ManifestError::BadVersion { .. })
    ));
}

#[test]
fn unknown_tier_rejects() {
    assert_eq!(
        run(&with(ui(), "tier", json!("wasm"))),
        Err(ManifestError::UnknownTier("wasm".into()))
    );
}

#[test]
fn bad_entry_paths_reject() {
    for p in [
        "",
        "/index.html",
        "../index.html",
        "ui/../../x.html",
        "C:/x.html",
        "c:\\x.html",
        "ui\\index.html",
        "ui//index.html",
        "con.html",
        "index.html:ads",
        "index.html.",
    ] {
        assert!(
            matches!(
                run(&with(ui(), "entry", json!(p))),
                Err(ManifestError::BadPath { field: "entry", .. })
            ),
            "{p:?}"
        );
    }
}

#[test]
fn entry_extension_must_match_tier() {
    assert!(matches!(
        run(&with(ui(), "entry", json!("main.js"))),
        Err(ManifestError::WrongEntryType { tier: "ui", .. })
    ));
    assert!(matches!(
        run(&with(ui(), "entry", json!(".html"))),
        Err(ManifestError::WrongEntryType { .. })
    ));
    assert!(matches!(
        run(&with(native(), "entry", json!("index.html"))),
        Err(ManifestError::WrongEntryType { tier: "native", .. })
    ));
    assert!(run(&with(native(), "entry", json!("bin/Tool.EXE"))).is_ok());
}

#[test]
fn unknown_capability_rejects() {
    assert_eq!(
        run(&with(ui(), "capabilities", json!(["files.write"]))),
        Err(ManifestError::UnknownCapability("files.write".into()))
    );
    assert_eq!(
        run(&with(ui(), "capabilities", json!(["Storage"]))),
        Err(ManifestError::UnknownCapability("Storage".into()))
    );
}

#[test]
fn every_known_capability_round_trips() {
    for cap in Capability::ALL {
        assert_eq!(Capability::parse(cap.as_str()), Some(cap));
    }
}

#[test]
fn duplicate_capability_rejects() {
    assert_eq!(
        run(&with(ui(), "capabilities", json!(["storage", "storage"]))),
        Err(ManifestError::DuplicateCapability("storage".into()))
    );
}

#[test]
fn audio_capabilities_are_native_only() {
    for cap in [
        "audio.tap",
        "audio.events",
        "audio.device",
        "audio.output_takeover",
    ] {
        assert!(
            matches!(
                run(&with(ui(), "capabilities", json!([cap]))),
                Err(ManifestError::CapabilityNotForTier { tier: "ui", .. })
            ),
            "{cap}"
        );
        let native_caps = if cap == "audio.device" {
            json!([cap, "audio.events"])
        } else {
            json!([cap])
        };
        assert!(
            run(&with(native(), "capabilities", native_caps)).is_ok(),
            "{cap} native"
        );
    }
}

#[test]
fn audio_device_requires_audio_events() {
    assert_eq!(
        run(&with(native(), "capabilities", json!(["audio.device"]))),
        Err(ManifestError::DeviceNeedsEvents)
    );
    assert_eq!(
        run(&with(
            native(),
            "capabilities",
            json!(["audio.tap", "audio.device"])
        )),
        Err(ManifestError::DeviceNeedsEvents)
    );
    for caps in [
        json!(["audio.device", "audio.events"]),
        json!(["audio.events", "audio.device"]),
    ] {
        assert!(run(&with(native(), "capabilities", caps)).is_ok());
    }
    assert!(ManifestError::DeviceNeedsEvents
        .to_string()
        .contains("audio.events"));
}

#[test]
fn page_is_accepted_on_native_and_optional() {
    assert_eq!(run(&native()).unwrap().page, None);
    let m = run(&with(native(), "page", json!("ui/Panel.HTML"))).unwrap();
    assert_eq!(m.page.as_deref(), Some("ui/Panel.HTML"));
    assert_eq!(m.entry, "bin/tool.exe");
}

#[test]
fn page_on_a_ui_manifest_rejects() {
    assert_eq!(
        run(&with(ui(), "page", json!("page.html"))),
        Err(ManifestError::BadPath {
            field: "page",
            reason: "is only for native plugins (a UI plugin's page is its 'entry')",
        })
    );
}

#[test]
fn bad_page_paths_reject() {
    for p in [
        "",
        "/page.html",
        "../page.html",
        "ui/../../x.html",
        "C:/x.html",
        "ui\\page.html",
        "ui//page.html",
        "con.html",
        "page.html:ads",
        "page.html.",
    ] {
        assert!(
            matches!(
                run(&with(native(), "page", json!(p))),
                Err(ManifestError::BadPath { field: "page", .. })
            ),
            "{p:?}"
        );
    }
}

#[test]
fn page_must_be_html() {
    for p in ["bin/tool.exe", "page.js", "page", ".html", "page.html.exe"] {
        assert_eq!(
            run(&with(native(), "page", json!(p))),
            Err(ManifestError::WrongPageType),
            "{p}"
        );
    }
}

#[test]
fn native_nav_items_require_a_page() {
    let v = with(native(), "capabilities", json!(["ui.sidebar"]));
    let nav = with(
        v.clone(),
        "sidebar",
        json!({ "items": [{ "id": "a", "type": "nav", "label": "A" }] }),
    );
    assert_eq!(run(&nav), Err(ManifestError::MissingPage));
    let reason = ManifestError::MissingPage.to_string();
    assert!(reason.contains("'nav'") && reason.contains("'page'"));
    assert!(run(&with(nav, "page", json!("page.html"))).is_ok());

    let live = with(
        v,
        "sidebar",
        json!({ "items": [
                { "id": "t", "type": "toggle", "label": "T" },
                { "id": "g", "type": "action", "label": "G" }
            ] }),
    );
    assert!(run(&live).is_ok());
}

#[test]
fn background_is_ui_only() {
    assert!(run(&with(ui(), "capabilities", json!(["background"]))).is_ok());
    assert!(matches!(
        run(&with(native(), "capabilities", json!(["background"]))),
        Err(ManifestError::CapabilityNotForTier {
            capability: "background",
            tier: "native"
        })
    ));
}

#[test]
fn ui_surface_capabilities_fit_both_tiers() {
    for tier in [ui(), with(native(), "page", json!("page.html"))] {
        let v = with(
            tier,
            "capabilities",
            json!(["ui.toast", "ui.confirm", "ui.chips", "ui.sidebar"]),
        );
        let v = with(
            v,
            "sidebar",
            json!({ "items": [{ "id": "a", "type": "nav", "label": "A" }] }),
        );
        assert!(run(&v).is_ok());
    }
}

#[test]
fn unknown_mode_rejects() {
    assert_eq!(
        run(&with(ui(), "modes", json!(["player", "karaoke"]))),
        Err(ManifestError::UnknownMode("karaoke".into()))
    );
}

#[test]
fn mode_list_rules() {
    assert_eq!(
        run(&with(ui(), "modes", json!([]))),
        Err(ManifestError::EmptyModes)
    );
    assert_eq!(
        run(&with(ui(), "modes", json!(["player", "player"]))),
        Err(ManifestError::DuplicateMode("player".into()))
    );
    let m = run(&with(ui(), "modes", json!(["organizer"]))).unwrap();
    assert_eq!(m.modes, vec![ModeOpt::Organizer]);
}

#[test]
fn homepage_must_be_https() {
    assert!(run(&with(ui(), "homepage", json!("https://example.com"))).is_ok());
    for url in [
        "http://example.com",
        "ftp://example.com",
        "javascript:alert(1)",
        "example.com",
        "https://",
        "https:///x",
        "https://exa mple.com",
        "https://a.com/\"x",
    ] {
        assert!(
            matches!(
                run(&with(ui(), "homepage", json!(url))),
                Err(ManifestError::BadHomepage(_))
            ),
            "{url}"
        );
    }
    let long = format!("https://example.com/{}", "a".repeat(MAX_HOMEPAGE));
    assert!(matches!(
        run(&with(ui(), "homepage", json!(long))),
        Err(ManifestError::BadHomepage(_))
    ));
}

#[test]
fn native_reason_required_for_native() {
    assert_eq!(
        run(&without(native(), "native_reason")),
        Err(ManifestError::MissingNativeReason)
    );
    assert!(matches!(
        run(&with(native(), "native_reason", json!(" "))),
        Err(ManifestError::EmptyField("native_reason"))
    ));
    assert!(matches!(
        run(&with(
            native(),
            "native_reason",
            json!("x".repeat(MAX_NATIVE_REASON + 1))
        )),
        Err(ManifestError::FieldTooLong {
            field: "native_reason",
            ..
        })
    ));
}

#[test]
fn native_reason_is_dropped_on_ui_plugins() {
    let m = run(&with(ui(), "native_reason", json!("because"))).unwrap();
    assert_eq!(m.native_reason, None);
}

#[test]
fn icon_path_and_type_rules() {
    assert!(run(&with(ui(), "icon", json!("icon.png"))).is_ok());
    assert!(run(&with(ui(), "icon", json!("a/b/icon.SVG"))).is_ok());
    for p in [
        "../icon.png",
        "/icon.png",
        "C:/icon.png",
        "icon\\x.png",
        "nul.png",
    ] {
        assert!(
            matches!(
                run(&with(ui(), "icon", json!(p))),
                Err(ManifestError::BadPath { field: "icon", .. })
            ),
            "{p}"
        );
    }
    for p in ["icon.jpg", "icon.gif", "icon", "icon.png.exe", ".png"] {
        assert_eq!(
            run(&with(ui(), "icon", json!(p))),
            Err(ManifestError::WrongIconType),
            "{p}"
        );
    }
}

#[test]
fn network_origins_required_with_capability() {
    let v = with(ui(), "capabilities", json!(["network"]));
    assert_eq!(run(&v), Err(ManifestError::NetworkOriginsRequired));
    assert_eq!(
        run(&with(v.clone(), "network", json!([]))),
        Err(ManifestError::NetworkOriginsRequired)
    );
    assert!(run(&with(v, "network", json!(["https://api.example.com"]))).is_ok());
}

#[test]
fn network_origins_rejected_without_capability() {
    assert_eq!(
        run(&with(ui(), "network", json!(["https://api.example.com"]))),
        Err(ManifestError::NetworkOriginsWithoutCapability)
    );
}

#[test]
fn bad_network_origins_reject() {
    let v = with(ui(), "capabilities", json!(["network"]));
    let frame_host = format!(
        "https://{}.invalid",
        crate::plugins::frame_host::host_for_id("a.b")
    );
    let long_label = format!("https://{}.example.com", "a".repeat(MAX_LABEL + 1));
    let reserved = "uses a reserved name that is not on the public internet";
    let dns = "must be a lowercase DNS host name";
    for (origin, expected) in [
        ("http://api.example.com", "must start with https://"),
        ("api.example.com", "must start with https://"),
        ("https://*.example.com", "must not use wildcards"),
        ("https://*", "must not use wildcards"),
        ("https://user@example.com", "must not carry credentials"),
        (
            "https://example.com/path",
            "must be a bare origin without a path, query or fragment",
        ),
        (
            "https://example.com/",
            "must be a bare origin without a path, query or fragment",
        ),
        (
            "https://example.com?x=1",
            "must be a bare origin without a path, query or fragment",
        ),
        (
            "https://example.com#f",
            "must be a bare origin without a path, query or fragment",
        ),
        ("https://example.com:0", "has an invalid port"),
        ("https://example.com:99999", "has an invalid port"),
        ("https://example.com:", "has an invalid port"),
        ("https://example.com:80a", "has an invalid port"),
        ("https://localhost", dns),
        ("https://127.0.0.1", "must not be an IP address"),
        ("https://1.2.3.4:8080", "must not be an IP address"),
        ("https://Example.com", dns),
        ("https://exa mple.com", dns),
        ("https://-a.example.com", dns),
        ("https://a..example.com", dns),
        ("https://example.com;x", dns),
        ("https://[::1]", "has an invalid port"),
        ("https://api.localhost", reserved),
        ("https://x.invalid", reserved),
        (frame_host.as_str(), reserved),
        ("https://a.test", reserved),
        ("https://printer.local", reserved),
        ("https://svc.internal", reserved),
        ("https://1.0.0.127.in-addr.arpa", reserved),
        ("https://x.onion", reserved),
        ("https://x.example", reserved),
        ("https://a.home", reserved),
        ("https://a.lan", reserved),
        ("https://a.corp", reserved),
        ("https://a.intranet", reserved),
        ("https://a.localdomain", reserved),
        (long_label.as_str(), dns),
    ] {
        assert_eq!(
            run(&with(v.clone(), "network", json!([origin]))),
            Err(ManifestError::BadNetworkOrigin {
                origin: clip(origin),
                reason: expected,
            }),
            "{origin}"
        );
    }
    let long = format!("https://{}.example.com", "a".repeat(MAX_ORIGIN));
    assert_eq!(
        run(&with(v.clone(), "network", json!([long]))),
        Err(ManifestError::BadNetworkOrigin {
            origin: clip(&long),
            reason: "is too long",
        })
    );
    let max_label = format!("https://{}.example.com", "a".repeat(MAX_LABEL));
    for origin in [
        "https://example.com",
        "https://a.example.com:8443",
        "https://localhost.com",
        max_label.as_str(),
    ] {
        assert!(
            run(&with(v.clone(), "network", json!([origin]))).is_ok(),
            "{origin}"
        );
    }
}

#[test]
fn dev_loopback_origins_are_accepted_with_their_kind() {
    for origin in [
        "http://127.0.0.1:8080",
        "http://localhost:1",
        "http://localhost:65535",
    ] {
        assert_eq!(origin_kind(origin), Ok(OriginKind::DevLoopback), "{origin}");
        let v = with(ui(), "capabilities", json!(["network"]));
        assert!(
            run(&with(v, "network", json!([origin]))).is_ok(),
            "{origin}"
        );
    }
    for origin in [
        "https://api.example.com",
        "https://example.com:8443",
        "https://a-b.example.co",
    ] {
        assert_eq!(origin_kind(origin), Ok(OriginKind::Public), "{origin}");
    }
}

#[test]
fn near_miss_loopback_origins_reject() {
    for origin in [
        "http://127.0.0.1",
        "http://127.0.0.2:80",
        "http://[::1]:80",
        "http://0.0.0.0:80",
        "http://localhost:080",
        "http://localhost:0",
        "http://localhost:8080/",
        "http://localhost:65536",
        "http://localhost:",
        "http://127.0.0.1:80a",
    ] {
        assert_eq!(origin_kind(origin), Err(NOT_DEV_ADDRESS), "{origin}");
    }
    assert_eq!(
        origin_kind("http://example.com:80"),
        Err("must start with https://")
    );
    assert_eq!(
        origin_kind("https://localhost:8443"),
        Err("must be a lowercase DNS host name")
    );
}

#[test]
fn network_origin_count_and_duplicates() {
    let v = with(ui(), "capabilities", json!(["network"]));
    let nine: Vec<String> = (0..9)
        .map(|i| format!("https://h{i}.example.com"))
        .collect();
    assert_eq!(
        run(&with(v.clone(), "network", json!(nine))),
        Err(ManifestError::TooManyNetworkOrigins(9))
    );
    let eight: Vec<String> = (0..8)
        .map(|i| format!("https://h{i}.example.com"))
        .collect();
    assert!(run(&with(v.clone(), "network", json!(eight))).is_ok());
    assert_eq!(
        run(&with(
            v,
            "network",
            json!(["https://a.example.com", "https://a.example.com"])
        )),
        Err(ManifestError::DuplicateNetworkOrigin(
            "https://a.example.com".into()
        ))
    );
}

#[test]
fn sidebar_errors_surface_with_context() {
    let v = with(
        ui(),
        "sidebar",
        json!({ "items": [{ "id": "a", "type": "nav", "label": "A" }] }),
    );
    assert_eq!(
        run(&v),
        Err(ManifestError::Sidebar(SidebarError::NeedsCapability))
    );

    let v = with(v, "capabilities", json!(["ui.sidebar"]));
    assert!(run(&v).is_ok());

    let live = with(
        v.clone(),
        "sidebar",
        json!({ "items": [{ "id": "a", "type": "toggle", "label": "A" }] }),
    );
    assert_eq!(
        run(&live),
        Err(ManifestError::Sidebar(SidebarError::NeedsBackground(
            "a".into()
        )))
    );

    let seven: Vec<Value> = (0..7)
        .map(|i| json!({ "id": format!("i{i}"), "type": "nav", "label": "A" }))
        .collect();
    assert_eq!(
        run(&with(v, "sidebar", json!({ "items": seven }))),
        Err(ManifestError::Sidebar(SidebarError::ItemCount(7)))
    );
}

#[test]
fn sidebar_layout_defaults_through_parse() {
    let v = with(ui(), "capabilities", json!(["ui.sidebar"]));
    let one = with(
        v.clone(),
        "sidebar",
        json!({ "layout": "section", "items": [{ "id": "a", "type": "nav", "label": "A" }] }),
    );
    assert_eq!(
        run(&one).unwrap().sidebar.unwrap().layout,
        sidebar_decl::Layout::Compact
    );
    let two = with(
        v,
        "sidebar",
        json!({ "layout": "section", "items": [{ "id": "a", "type": "nav", "label": "A" }, { "id": "b", "type": "nav", "label": "B" }] }),
    );
    assert_eq!(
        run(&two).unwrap().sidebar.unwrap().layout,
        sidebar_decl::Layout::Section
    );
}

#[test]
fn min_plisto_above_running_is_incompatible_not_invalid() {
    let running = SemVer::parse("2.6.2").unwrap();
    let p = |min: &str| {
        parse_against(
            with(ui(), "min_plisto", json!(min)).to_string().as_bytes(),
            Some(&running),
        )
    };
    assert_eq!(p("2.6.2").unwrap().compat, Compat::Compatible);
    assert_eq!(p("2.6.1").unwrap().compat, Compat::Compatible);
    assert_eq!(
        p("2.6.3").unwrap().compat,
        Compat::NeedsNewer("2.6.3".into())
    );
    assert_eq!(
        p("3.0.0").unwrap().compat,
        Compat::NeedsNewer("3.0.0".into())
    );
    assert_eq!(
        p("2.7.0-beta.1").unwrap().compat,
        Compat::NeedsNewer("2.7.0-beta.1".into())
    );
}

#[test]
fn running_prerelease_sits_below_its_release() {
    let running = SemVer::parse("2.7.0-beta.1").unwrap();
    let bytes = with(ui(), "min_plisto", json!("2.7.0")).to_string();
    assert_eq!(
        parse_against(bytes.as_bytes(), Some(&running))
            .unwrap()
            .compat,
        Compat::NeedsNewer("2.7.0".into())
    );
}

#[test]
fn echoed_values_are_clipped_to_one_line() {
    let huge = format!("evil\n{}", "x".repeat(60_000));
    let caps = run(&with(ui(), "capabilities", json!([huge.clone()])))
        .unwrap_err()
        .to_string();
    let mode = run(&with(ui(), "modes", json!([huge.clone()])))
        .unwrap_err()
        .to_string();
    let v = with(ui(), "capabilities", json!(["network"]));
    let origin = run(&with(v, "network", json!([huge])))
        .unwrap_err()
        .to_string();
    for line in [caps, mode, origin] {
        assert!(!line.contains('\n') && line.len() < 120, "{line}");
    }
}

#[test]
fn invisible_and_bidi_characters_reject() {
    for c in [
        '\u{202E}', '\u{200B}', '\u{00AD}', '\u{061C}', '\u{180E}', '\u{2066}', '\u{FEFF}',
        '\u{FFFA}', '\u{2028}',
    ] {
        let text = format!("Demo{c}Plugin");
        assert_eq!(
            run(&with(ui(), "name", json!(text.clone()))),
            Err(ManifestError::ControlChars("name")),
            "{c:?}"
        );
        assert_eq!(
            run(&with(ui(), "author", json!(text))),
            Err(ManifestError::ControlChars("author")),
            "{c:?}"
        );
    }
    let v = with(native(), "native_reason", json!("reads audio\u{202E}"));
    assert_eq!(run(&v), Err(ManifestError::ControlChars("native_reason")));
}

#[test]
fn combining_mark_runs_are_bounded() {
    let marks = |n: usize| "\u{0301}".repeat(n);
    let at_limit = format!("A{}", marks(MAX_COMBINING_RUN));
    assert!(text_problem(&at_limit, 60).is_none());
    let over = format!("A{}", marks(MAX_COMBINING_RUN + 1));
    assert!(matches!(
        text_problem(&over, 60),
        Some(TextProblem::Stacked)
    ));
    let split = format!("A{}b{}", marks(5), marks(5));
    assert!(text_problem(&split, 60).is_none());
    for ok in [
        "Tie\u{0302}\u{0301}ng Vie\u{0323}\u{0302}t",
        "\u{0E19}\u{0E49}\u{0E33}",
    ] {
        assert!(text_problem(ok, 60).is_none(), "{ok}");
    }
}

#[test]
fn stacked_marks_in_a_name_reach_the_author() {
    let name = format!("A{}", "\u{0301}".repeat(MAX_COMBINING_RUN + 1));
    let err = run(&with(ui(), "name", json!(name))).unwrap_err();
    assert_eq!(err, ManifestError::StackedMarks("name"));
    assert!(err.to_string().contains("combining marks"));
}

#[test]
fn ordinary_non_ascii_text_passes() {
    for name in ["Caf\u{e9} Mix", "\u{97f3}\u{697d}", "Party \u{1F389}"] {
        assert!(run(&with(ui(), "name", json!(name))).is_ok(), "{name}");
    }
}

#[test]
fn numeric_looking_last_label_is_not_a_host() {
    let v = with(ui(), "capabilities", json!(["network"]));
    for origin in [
        "https://127.0.0.0x1",
        "https://1.2.3.0x7f",
        "https://example.0",
        "https://example.017",
    ] {
        assert!(
            matches!(
                run(&with(v.clone(), "network", json!([origin]))),
                Err(ManifestError::BadNetworkOrigin { .. })
            ),
            "{origin}"
        );
    }
    for origin in [
        "https://example.com",
        "https://api.example.xn--p1ai",
        "https://example.com:8443",
    ] {
        assert!(
            run(&with(v.clone(), "network", json!([origin]))).is_ok(),
            "{origin}"
        );
    }
}

#[test]
fn errors_display_as_one_line() {
    let e = run(&with(ui(), "capabilities", json!(["files.write"]))).unwrap_err();
    assert_eq!(e.to_string(), "unknown capability 'files.write'");
    let e = run(&with(ui(), "tier", json!("a\nb"))).unwrap_err();
    assert!(!e.to_string().contains('\n'));
}
