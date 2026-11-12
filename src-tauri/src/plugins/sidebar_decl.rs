/*
 * The optional `sidebar` block of a plugin manifest: what the plugin asks Plisto to draw in the
 * sidebar. Pure validation only. Plisto draws every item from this closed vocabulary, so nothing
 * here is plugin markup, and the caps keep a manifest from flooding the sidebar.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};

// -- Local Imports --
use super::manifest::{clip, text_problem, Capability, TextProblem, Tier};

pub const MAX_ITEMS: usize = 6;
pub const MAX_LABEL: usize = 24;
pub const MAX_ITEM_ID: usize = 32;
pub const MAX_ROUTE: usize = 64;

// The Plisto-mapped icon names a nav item may use (lucide names). Anything else rejects.
pub const ICON_NAMES: &[&str] = &[
    "activity",
    "album",
    "archive",
    "audio-lines",
    "audio-waveform",
    "bell",
    "bookmark",
    "chart-bar",
    "circle-help",
    "clock",
    "cloud",
    "cog",
    "compass",
    "database",
    "disc-3",
    "download",
    "drum",
    "file-text",
    "folder",
    "gauge",
    "globe",
    "guitar",
    "headphones",
    "heart",
    "house",
    "info",
    "layout-grid",
    "library",
    "list-music",
    "mic",
    "music",
    "music-2",
    "puzzle",
    "radio",
    "sliders-horizontal",
    "sparkles",
    "star",
    "tag",
    "timer",
    "wand-sparkles",
    "zap",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    Compact,
    Section,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Nav,
    Status,
    Progress,
    Toggle,
    Action,
}

impl ItemType {
    fn parse(s: &str) -> Option<ItemType> {
        Some(match s {
            "nav" => ItemType::Nav,
            "status" => ItemType::Status,
            "progress" => ItemType::Progress,
            "toggle" => ItemType::Toggle,
            "action" => ItemType::Action,
            _ => return None,
        })
    }

    /// Items that update or receive clicks need a runtime, so a UI plugin must keep a frame alive.
    fn is_live(self) -> bool {
        !matches!(self, ItemType::Nav)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SidebarItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ItemType,
    pub label: String,
    pub route: Option<String>,
    pub icon: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SidebarDecl {
    pub layout: Layout,
    pub items: Vec<SidebarItem>,
}

#[derive(Deserialize)]
pub(super) struct RawSidebar {
    layout: Option<String>,
    items: Option<Vec<RawItem>>,
}

#[derive(Deserialize)]
struct RawItem {
    id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    label: Option<String>,
    route: Option<String>,
    icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidebarError {
    NeedsCapability,
    ItemCount(usize),
    UnknownLayout(String),
    MissingItemField { index: usize, field: &'static str },
    BadItemId(String),
    DuplicateItemId(String),
    EmptyLabel(String),
    LabelTooLong(String),
    LabelControlChars(String),
    UnknownType { item: String, kind: String },
    UnknownIcon { item: String, icon: String },
    BadRoute { item: String, reason: &'static str },
    FieldNotAllowed { item: String, field: &'static str },
    NeedsBackground(String),
}

impl fmt::Display for SidebarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SidebarError::NeedsCapability => {
                write!(f, "sidebar block requires the 'ui.sidebar' capability")
            }
            SidebarError::ItemCount(n) => {
                write!(f, "sidebar must have 1 to {MAX_ITEMS} items, found {n}")
            }
            SidebarError::UnknownLayout(l) => write!(f, "unknown sidebar layout '{l}'"),
            SidebarError::MissingItemField { index, field } => {
                write!(f, "sidebar item {} is missing '{field}'", index + 1)
            }
            SidebarError::BadItemId(id) => write!(
                f,
                "sidebar item id '{id}' must be 1 to {MAX_ITEM_ID} characters of a-z, 0-9 and '-'"
            ),
            SidebarError::DuplicateItemId(id) => write!(f, "duplicate sidebar item id '{id}'"),
            SidebarError::EmptyLabel(id) => write!(f, "sidebar item '{id}' has an empty label"),
            SidebarError::LabelTooLong(id) => {
                write!(
                    f,
                    "sidebar item '{id}' label is over {MAX_LABEL} characters"
                )
            }
            SidebarError::LabelControlChars(id) => {
                write!(f, "sidebar item '{id}' label has control characters")
            }
            SidebarError::UnknownType { item, kind } => {
                write!(f, "sidebar item '{item}' has unknown type '{kind}'")
            }
            SidebarError::UnknownIcon { item, icon } => {
                write!(f, "sidebar item '{item}' has unknown icon '{icon}'")
            }
            SidebarError::BadRoute { item, reason } => {
                write!(f, "sidebar item '{item}' route {reason}")
            }
            SidebarError::FieldNotAllowed { item, field } => {
                write!(
                    f,
                    "sidebar item '{item}': '{field}' is only allowed on nav items"
                )
            }
            SidebarError::NeedsBackground(id) => write!(
                f,
                "sidebar item '{id}' is live and requires the 'background' capability"
            ),
        }
    }
}

fn valid_item_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ITEM_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn route_problem(route: &str) -> Option<&'static str> {
    if route.is_empty() {
        return Some("must not be empty");
    }
    if route.len() > MAX_ROUTE {
        return Some("is too long");
    }
    if !route.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Some("may only contain visible ASCII characters");
    }
    None
}

/// Validates a raw block against the plugin's tier and capabilities. A block with fewer than 2 items
/// is forced to `compact`, since a section heading over one row adds nothing.
pub(super) fn validate(
    raw: RawSidebar,
    tier: Tier,
    caps: &[Capability],
) -> Result<SidebarDecl, SidebarError> {
    if !caps.contains(&Capability::UiSidebar) {
        return Err(SidebarError::NeedsCapability);
    }
    let layout = match raw.layout.as_deref() {
        None | Some("compact") => Layout::Compact,
        Some("section") => Layout::Section,
        Some(other) => return Err(SidebarError::UnknownLayout(clip(other))),
    };
    let raw_items = raw.items.unwrap_or_default();
    if raw_items.is_empty() || raw_items.len() > MAX_ITEMS {
        return Err(SidebarError::ItemCount(raw_items.len()));
    }

    let needs_background = tier == Tier::Ui && !caps.contains(&Capability::Background);
    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(raw_items.len());
    for (index, item) in raw_items.into_iter().enumerate() {
        let missing = |field| SidebarError::MissingItemField { index, field };
        let id = item.id.ok_or_else(|| missing("id"))?;
        if !valid_item_id(&id) {
            return Err(SidebarError::BadItemId(clip(&id)));
        }
        if !seen.insert(id.clone()) {
            return Err(SidebarError::DuplicateItemId(id));
        }
        let kind_str = item.kind.ok_or_else(|| missing("type"))?;
        let kind = ItemType::parse(&kind_str).ok_or_else(|| SidebarError::UnknownType {
            item: id.clone(),
            kind: clip(&kind_str),
        })?;
        let label = item.label.ok_or_else(|| missing("label"))?;
        match text_problem(&label, MAX_LABEL) {
            Some(TextProblem::Empty) => return Err(SidebarError::EmptyLabel(id)),
            Some(TextProblem::TooLong) => return Err(SidebarError::LabelTooLong(id)),
            Some(TextProblem::Control) => return Err(SidebarError::LabelControlChars(id)),
            None => {}
        }
        if kind != ItemType::Nav {
            if item.route.is_some() {
                return Err(SidebarError::FieldNotAllowed {
                    item: id,
                    field: "route",
                });
            }
            if item.icon.is_some() {
                return Err(SidebarError::FieldNotAllowed {
                    item: id,
                    field: "icon",
                });
            }
        }
        if let Some(route) = &item.route {
            if let Some(reason) = route_problem(route) {
                return Err(SidebarError::BadRoute { item: id, reason });
            }
        }
        if let Some(icon) = &item.icon {
            if !ICON_NAMES.contains(&icon.as_str()) {
                return Err(SidebarError::UnknownIcon {
                    item: id,
                    icon: clip(icon),
                });
            }
        }
        if kind.is_live() && needs_background {
            return Err(SidebarError::NeedsBackground(id));
        }
        items.push(SidebarItem {
            id,
            kind,
            label,
            route: item.route,
            icon: item.icon,
        });
    }

    let layout = if items.len() < 2 {
        Layout::Compact
    } else {
        layout
    };
    Ok(SidebarDecl { layout, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn run(v: Value, tier: Tier, caps: &[Capability]) -> Result<SidebarDecl, SidebarError> {
        validate(serde_json::from_value(v).unwrap(), tier, caps)
    }

    const UI_CAPS: &[Capability] = &[Capability::UiSidebar];
    const UI_BG: &[Capability] = &[Capability::UiSidebar, Capability::Background];

    fn nav(id: &str) -> Value {
        json!({ "id": id, "type": "nav", "label": "Page" })
    }

    #[test]
    fn nav_only_ui_block_needs_no_background() {
        let d = run(
            json!({ "layout": "section", "items": [nav("a"), nav("b")] }),
            Tier::Ui,
            UI_CAPS,
        )
        .unwrap();
        assert_eq!(d.layout, Layout::Section);
        assert_eq!(d.items.len(), 2);
    }

    #[test]
    fn layout_defaults_to_compact() {
        let d = run(json!({ "items": [nav("a"), nav("b")] }), Tier::Ui, UI_CAPS).unwrap();
        assert_eq!(d.layout, Layout::Compact);
    }

    #[test]
    fn single_item_forces_compact() {
        let d = run(
            json!({ "layout": "section", "items": [nav("a")] }),
            Tier::Ui,
            UI_CAPS,
        )
        .unwrap();
        assert_eq!(d.layout, Layout::Compact);
    }

    #[test]
    fn six_items_pass_seven_reject() {
        let six: Vec<Value> = (0..6).map(|i| nav(&format!("i{i}"))).collect();
        assert!(run(json!({ "items": six }), Tier::Ui, UI_CAPS).is_ok());
        let seven: Vec<Value> = (0..7).map(|i| nav(&format!("i{i}"))).collect();
        assert_eq!(
            run(json!({ "items": seven }), Tier::Ui, UI_CAPS),
            Err(SidebarError::ItemCount(7))
        );
    }

    #[test]
    fn zero_or_absent_items_reject() {
        assert_eq!(
            run(json!({ "items": [] }), Tier::Ui, UI_CAPS),
            Err(SidebarError::ItemCount(0))
        );
        assert_eq!(
            run(json!({}), Tier::Ui, UI_CAPS),
            Err(SidebarError::ItemCount(0))
        );
    }

    #[test]
    fn missing_ui_sidebar_capability_rejects() {
        assert_eq!(
            run(
                json!({ "items": [nav("a")] }),
                Tier::Ui,
                &[Capability::Background]
            ),
            Err(SidebarError::NeedsCapability)
        );
    }

    #[test]
    fn unknown_layout_rejects() {
        assert_eq!(
            run(
                json!({ "layout": "wide", "items": [nav("a")] }),
                Tier::Ui,
                UI_CAPS
            ),
            Err(SidebarError::UnknownLayout("wide".into()))
        );
    }

    #[test]
    fn duplicate_item_id_rejects() {
        assert_eq!(
            run(json!({ "items": [nav("a"), nav("a")] }), Tier::Ui, UI_CAPS),
            Err(SidebarError::DuplicateItemId("a".into()))
        );
    }

    #[test]
    fn bad_item_ids_reject() {
        let long = "a".repeat(33);
        for id in ["", "A", "a b", "a_b", "a.b", long.as_str()] {
            let r = run(json!({ "items": [nav(id)] }), Tier::Ui, UI_CAPS);
            assert_eq!(r, Err(SidebarError::BadItemId(id.into())), "{id:?}");
        }
        let ok = "a".repeat(32);
        assert!(run(json!({ "items": [nav(&ok)] }), Tier::Ui, UI_CAPS).is_ok());
    }

    #[test]
    fn label_rules() {
        let item = |label: &str| json!({ "items": [{ "id": "a", "type": "nav", "label": label }] });
        assert!(run(item(&"x".repeat(24)), Tier::Ui, UI_CAPS).is_ok());
        assert_eq!(
            run(item(&"x".repeat(25)), Tier::Ui, UI_CAPS),
            Err(SidebarError::LabelTooLong("a".into()))
        );
        assert_eq!(
            run(item("   "), Tier::Ui, UI_CAPS),
            Err(SidebarError::EmptyLabel("a".into()))
        );
        assert_eq!(
            run(item("a\nb"), Tier::Ui, UI_CAPS),
            Err(SidebarError::LabelControlChars("a".into()))
        );
    }

    #[test]
    fn missing_item_fields_reject() {
        assert_eq!(
            run(
                json!({ "items": [{ "type": "nav", "label": "x" }] }),
                Tier::Ui,
                UI_CAPS
            ),
            Err(SidebarError::MissingItemField {
                index: 0,
                field: "id"
            })
        );
        assert_eq!(
            run(
                json!({ "items": [{ "id": "a", "label": "x" }] }),
                Tier::Ui,
                UI_CAPS
            ),
            Err(SidebarError::MissingItemField {
                index: 0,
                field: "type"
            })
        );
        assert_eq!(
            run(
                json!({ "items": [{ "id": "a", "type": "nav" }] }),
                Tier::Ui,
                UI_CAPS
            ),
            Err(SidebarError::MissingItemField {
                index: 0,
                field: "label"
            })
        );
    }

    #[test]
    fn unknown_type_rejects() {
        assert_eq!(
            run(
                json!({ "items": [{ "id": "a", "type": "html", "label": "x" }] }),
                Tier::Ui,
                UI_BG
            ),
            Err(SidebarError::UnknownType {
                item: "a".into(),
                kind: "html".into()
            })
        );
    }

    #[test]
    fn unknown_icon_rejects_known_passes() {
        let item = |icon: &str| json!({ "items": [{ "id": "a", "type": "nav", "label": "x", "icon": icon }] });
        assert!(run(item("music"), Tier::Ui, UI_CAPS).is_ok());
        assert_eq!(
            run(item("not-an-icon"), Tier::Ui, UI_CAPS),
            Err(SidebarError::UnknownIcon {
                item: "a".into(),
                icon: "not-an-icon".into()
            })
        );
    }

    #[test]
    fn route_rules() {
        let item = |route: &str| json!({ "items": [{ "id": "a", "type": "nav", "label": "x", "route": route }] });
        assert!(run(item(&"r".repeat(64)), Tier::Ui, UI_CAPS).is_ok());
        for bad in ["", "has space", &"r".repeat(65)] {
            assert!(
                matches!(
                    run(item(bad), Tier::Ui, UI_CAPS),
                    Err(SidebarError::BadRoute { .. })
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn route_and_icon_only_on_nav() {
        let route =
            json!({ "items": [{ "id": "a", "type": "status", "label": "x", "route": "r" }] });
        assert_eq!(
            run(route, Tier::Native, UI_CAPS),
            Err(SidebarError::FieldNotAllowed {
                item: "a".into(),
                field: "route"
            })
        );
        let icon =
            json!({ "items": [{ "id": "a", "type": "action", "label": "x", "icon": "music" }] });
        assert_eq!(
            run(icon, Tier::Native, UI_CAPS),
            Err(SidebarError::FieldNotAllowed {
                item: "a".into(),
                field: "icon"
            })
        );
    }

    #[test]
    fn live_items_need_background_on_ui_tier_only() {
        for kind in ["status", "progress", "toggle", "action"] {
            let block = json!({ "items": [{ "id": "a", "type": kind, "label": "x" }] });
            assert_eq!(
                run(block.clone(), Tier::Ui, UI_CAPS),
                Err(SidebarError::NeedsBackground("a".into())),
                "{kind}"
            );
            assert!(
                run(block.clone(), Tier::Ui, UI_BG).is_ok(),
                "{kind} with background"
            );
            assert!(run(block, Tier::Native, UI_CAPS).is_ok(), "{kind} native");
        }
    }

    #[test]
    fn echoed_values_are_clipped() {
        let huge = format!("a\n{}", "x".repeat(60_000));
        let errs = [
            run(
                json!({ "layout": huge, "items": [nav("a")] }),
                Tier::Ui,
                UI_CAPS,
            ),
            run(json!({ "items": [nav(&huge)] }), Tier::Ui, UI_CAPS),
            run(
                json!({ "items": [{ "id": "a", "type": huge, "label": "x" }] }),
                Tier::Ui,
                UI_CAPS,
            ),
            run(
                json!({ "items": [{ "id": "a", "type": "nav", "label": "x", "icon": huge }] }),
                Tier::Ui,
                UI_CAPS,
            ),
        ];
        for e in errs {
            let line = e.unwrap_err().to_string();
            assert!(!line.contains('\n') && line.len() < 140, "{line}");
        }
    }

    #[test]
    fn invisible_label_characters_reject() {
        for c in ['\u{200B}', '\u{202E}'] {
            let block =
                json!({ "items": [{ "id": "a", "type": "nav", "label": format!("a{c}b") }] });
            assert_eq!(
                run(block, Tier::Ui, UI_CAPS),
                Err(SidebarError::LabelControlChars("a".into()))
            );
        }
        let ok = json!({ "items": [{ "id": "a", "type": "nav", "label": "Caf\u{e9} \u{97f3}\u{1F389}" }] });
        assert!(run(ok, Tier::Ui, UI_CAPS).is_ok());
    }

    #[test]
    fn display_is_one_line() {
        let e = SidebarError::UnknownType {
            item: "a".into(),
            kind: "html".into(),
        };
        assert_eq!(e.to_string(), "sidebar item 'a' has unknown type 'html'");
    }
}
