/*
 * What a plugin says about its own sidebar rows: `ui.chips` and `ui.sidebar.update`, the live state
 * they leave in memory, the boot snapshot of that state, and the check that turns a click on a toggle
 * or an action into a gesture. The manifest declaration is the only source of which items exist, so an
 * update can set the state of a declared item and nothing else. Every update replaces the whole state
 * of its item, with a default for each field it leaves out. Plugin text is validated here and never
 * reaches an error message or a log.
 */

// -- Library Imports --
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Map, Value};

// -- Local Imports --
use super::error::ApiError;
use super::host_event::{HostEvent, SidebarEvent, SidebarKind};
use super::rate::RateClass;
use super::state::{lock, ApiState};
use super::ui::{optional_text_arg, text_arg, Field};
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::plugins::manifest::Capability;
use crate::plugins::paths::plugin_dir;
use crate::plugins::sidebar_decl::{ItemType, Layout, SidebarDecl};
use crate::plugins::state::EnabledSet;
use crate::plugins::summary::read_manifest;

pub const MAX_CHIPS: usize = 2;
pub const MAX_CHIP_TEXT: usize = 12;
pub const MAX_LABEL: usize = 24;
pub const MAX_STATUS_TEXT: usize = 40;

pub(super) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "ui.chips",
        need: Need::Cap(Capability::UiChips),
        class: RateClass::Chips,
        run: chips,
    },
    MethodSpec {
        name: "ui.sidebar.update",
        need: Need::Cap(Capability::UiSidebar),
        class: RateClass::Sidebar,
        run: update,
    },
];

const CHIP_TEXT: Field = Field {
    name: "text",
    cap: MAX_CHIP_TEXT,
    invalid: "A chip 'text' must be a non-blank string with no control or invisible characters.",
    too_long: "A chip 'text' is over 12 characters.",
};

const LABEL: Field = Field {
    name: "label",
    cap: MAX_LABEL,
    invalid: "'label' must be null or a non-blank string with no control or invisible characters.",
    too_long: "'label' is over 24 characters.",
};

const STATUS_TEXT: Field = Field {
    name: "text",
    cap: MAX_STATUS_TEXT,
    invalid: "'text' must be a non-blank string with no control or invisible characters.",
    too_long: "'text' is over 40 characters.",
};

const PROGRESS_TEXT: Field = Field {
    name: "text",
    cap: MAX_STATUS_TEXT,
    invalid: "'text' must be null or a non-blank string with no control or invisible characters.",
    too_long: "'text' is over 40 characters.",
};

// Every field any item type takes; a field of another type's shape is refused rather than ignored.
const STATE_FIELDS: &[&str] = &[
    "label", "chip", "visible", "text", "tone", "value", "on", "enabled",
];
const NAV_FIELDS: &[&str] = &["label", "chip", "visible"];
const STATUS_FIELDS: &[&str] = &["text", "tone", "visible"];
const PROGRESS_FIELDS: &[&str] = &["value", "text", "visible"];
const TOGGLE_FIELDS: &[&str] = &["on", "enabled", "visible"];
const ACTION_FIELDS: &[&str] = &["label", "enabled", "visible"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Neutral,
    Accent,
    Warn,
}

/// One chip beside a plugin's row: free text or a count.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Chip {
    pub text: Option<String>,
    pub count: Option<u32>,
    pub tone: Tone,
}

/// The live state of one declared item. Every field is always set.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ItemState {
    Nav {
        visible: bool,
        label: Option<String>,
        chip: Option<Chip>,
    },
    Status {
        visible: bool,
        tone: Tone,
        text: String,
    },
    Progress {
        visible: bool,
        value: Option<f64>,
        text: Option<String>,
    },
    Toggle {
        visible: bool,
        on: bool,
        enabled: bool,
    },
    Action {
        visible: bool,
        label: Option<String>,
        enabled: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ItemEntry {
    pub item_id: String,
    pub state: ItemState,
}

/// One plugin's live sidebar state at boot.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SidebarSnapshot {
    pub id: String,
    pub chips: Vec<Chip>,
    pub items: Vec<ItemEntry>,
}

/// What a frame is told about a click: the item, the new value of a toggle, and the gesture the
/// click earned. The token is never printed, so this does not implement `Debug`.
#[derive(Clone, Serialize)]
pub struct SidebarDelivery {
    pub item_id: String,
    pub value: Option<bool>,
    pub gesture: String,
}

/// The answer to a click: whether Plisto took it, and what to hand the plugin's frame.
#[derive(Clone, Serialize)]
pub struct SidebarInputReply {
    pub accepted: bool,
    pub frame: Option<SidebarDelivery>,
}

#[derive(Default)]
struct PluginSidebar {
    // The manifest declaration with the version it was read for; a plugin with no block caches an
    // empty one.
    decl: Option<(String, Arc<SidebarDecl>)>,
    chips: Vec<Chip>,
    items: BTreeMap<String, ItemState>,
}

impl PluginSidebar {
    fn is_empty(&self) -> bool {
        self.chips.is_empty() && self.items.is_empty()
    }
}

/// The live sidebar state of every plugin, memory only. The lock covers map work: no manifest is
/// read and no event is sent while it is held.
#[derive(Default)]
pub struct SidebarStore {
    plugins: Mutex<HashMap<String, PluginSidebar>>,
}

impl SidebarStore {
    fn cached(&self, id: &str, version: &str) -> Option<Arc<SidebarDecl>> {
        let plugins = lock(&self.plugins);
        match &plugins.get(id)?.decl {
            Some((cached, decl)) if cached == version => Some(decl.clone()),
            _ => None,
        }
    }

    fn cache(&self, id: &str, version: &str, decl: Arc<SidebarDecl>) {
        let mut plugins = lock(&self.plugins);
        plugins.entry(id.to_string()).or_default().decl = Some((version.to_string(), decl));
    }

    #[cfg(test)]
    fn set_chips(&self, id: &str, chips: Vec<Chip>) {
        let mut plugins = lock(&self.plugins);
        plugins.entry(id.to_string()).or_default().chips = chips;
    }

    // The serving check and the store share the store lock, so a write can never land after `forget`
    // has cleared a plugin that is no longer serving. Lock order: store, then the serving set; the
    // serving set's lock is never held while taking the store's, and this is the only nesting.
    /// Stores `chips` when `id` is serving; `false` when it is not.
    fn set_chips_serving(&self, id: &str, enabled: &EnabledSet, chips: Vec<Chip>) -> bool {
        let mut plugins = lock(&self.plugins);
        if enabled.serving(id).is_none() {
            return false;
        }
        plugins.entry(id.to_string()).or_default().chips = chips;
        true
    }

    /// Stores one item's state when `id` is serving; `false` when it is not. Locks as `set_chips_serving`.
    fn set_item_serving(
        &self,
        id: &str,
        enabled: &EnabledSet,
        item_id: &str,
        state: ItemState,
    ) -> bool {
        let mut plugins = lock(&self.plugins);
        if enabled.serving(id).is_none() {
            return false;
        }
        let plugin = plugins.entry(id.to_string()).or_default();
        plugin.items.insert(item_id.to_string(), state);
        true
    }

    /// Drops everything kept for `id`, its cached declaration included.
    pub fn forget(&self, id: &str) {
        lock(&self.plugins).remove(id);
    }

    /// The state of every serving plugin that has any, by id.
    pub fn snapshot(&self, enabled: &EnabledSet) -> Vec<SidebarSnapshot> {
        let mut all: Vec<SidebarSnapshot> = lock(&self.plugins)
            .iter()
            .filter(|(_, plugin)| !plugin.is_empty())
            .map(|(id, plugin)| SidebarSnapshot {
                id: id.clone(),
                chips: plugin.chips.clone(),
                items: plugin
                    .items
                    .iter()
                    .map(|(item_id, state)| ItemEntry {
                        item_id: item_id.clone(),
                        state: state.clone(),
                    })
                    .collect(),
            })
            .collect();
        // The serving set is read after the store lock is released, never under it.
        all.retain(|s| enabled.serving(&s.id).is_some());
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }
}

/// The declaration of `id`'s sidebar for `version`, read from its installed manifest on first use and
/// cached until a different version serves or the plugin is forgotten. A manifest with no sidebar
/// block declares no items.
fn declaration(
    api: &ApiState,
    app_data: &Path,
    id: &str,
    version: &str,
) -> Result<Arc<SidebarDecl>, ApiError> {
    if let Some(decl) = api.sidebar().cached(id, version) {
        return Ok(decl);
    }
    let manifest = read_manifest(&plugin_dir(app_data, id)).ok_or_else(ApiError::unavailable)?;
    let decl = Arc::new(manifest.sidebar.unwrap_or(SidebarDecl {
        layout: Layout::Compact,
        items: Vec::new(),
    }));
    api.sidebar().cache(id, version, decl.clone());
    Ok(decl)
}

fn wire<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn invalid(message: &'static str) -> ApiError {
    ApiError::invalid_args(message)
}

fn chip_tone(map: &Map<String, Value>) -> Result<Tone, ApiError> {
    match map.get("tone") {
        None | Some(Value::Null) => Ok(Tone::Neutral),
        Some(Value::String(tone)) => match tone.as_str() {
            "neutral" => Ok(Tone::Neutral),
            "accent" => Ok(Tone::Accent),
            "warn" => Ok(Tone::Warn),
            _ => Err(invalid("'tone' must be neutral, accent or warn.")),
        },
        Some(_) => Err(invalid("'tone' must be neutral, accent or warn.")),
    }
}

fn chip_count(map: &Map<String, Value>) -> Result<Option<u32>, ApiError> {
    match map.get("count") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|count| *count <= i32::MAX as u64)
            .map(|count| Some(count as u32))
            .ok_or_else(|| invalid("A chip 'count' must be an integer from 0 to 2147483647.")),
    }
}

fn chip_from(value: &Value) -> Result<Chip, ApiError> {
    let Value::Object(map) = value else {
        return Err(invalid("A chip must be an object."));
    };
    let text = optional_text_arg(map, &CHIP_TEXT)?;
    let count = chip_count(map)?;
    if text.is_some() == count.is_some() {
        return Err(invalid("A chip needs exactly one of 'text' and 'count'."));
    }
    Ok(Chip {
        text,
        count,
        tone: chip_tone(map)?,
    })
}

fn flag(map: &Map<String, Value>, name: &str, default: bool) -> Result<bool, ApiError> {
    match map.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid("'visible' and 'enabled' must be booleans.")),
    }
}

fn required_flag(map: &Map<String, Value>, name: &str) -> Result<bool, ApiError> {
    match map.get(name) {
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(invalid("'on' is required and must be a boolean.")),
    }
}

fn progress_value(map: &Map<String, Value>) -> Result<Option<f64>, ApiError> {
    let bad = || invalid("'value' is required: null, or a number from 0 to 1.");
    match map.get("value") {
        Some(Value::Null) => Ok(None),
        // Adding zero turns -0.0 into 0.0.
        Some(Value::Number(n)) => match n.as_f64() {
            Some(value) if (0.0..=1.0).contains(&value) => Ok(Some(value + 0.0)),
            _ => Err(bad()),
        },
        _ => Err(bad()),
    }
}

fn chip_arg(map: &Map<String, Value>) -> Result<Option<Chip>, ApiError> {
    match map.get("chip") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => chip_from(value).map(Some),
    }
}

/// Refuses a field that belongs to another item type; unknown names stay ignored.
fn reject_foreign(map: &Map<String, Value>, own: &[&str]) -> Result<(), ApiError> {
    let foreign = map
        .keys()
        .any(|key| STATE_FIELDS.contains(&key.as_str()) && !own.contains(&key.as_str()));
    if foreign {
        return Err(invalid(
            "The state has a field its item type does not take.",
        ));
    }
    Ok(())
}

/// The state `map` asks for on an item of type `kind`, with a default for every field left out.
fn parse_state(kind: ItemType, map: &Map<String, Value>) -> Result<ItemState, ApiError> {
    match kind {
        ItemType::Nav => {
            reject_foreign(map, NAV_FIELDS)?;
            Ok(ItemState::Nav {
                visible: flag(map, "visible", true)?,
                label: optional_text_arg(map, &LABEL)?,
                chip: chip_arg(map)?,
            })
        }
        ItemType::Status => {
            reject_foreign(map, STATUS_FIELDS)?;
            Ok(ItemState::Status {
                visible: flag(map, "visible", true)?,
                tone: chip_tone(map)?,
                text: text_arg(map, &STATUS_TEXT)?,
            })
        }
        ItemType::Progress => {
            reject_foreign(map, PROGRESS_FIELDS)?;
            Ok(ItemState::Progress {
                visible: flag(map, "visible", true)?,
                value: progress_value(map)?,
                text: optional_text_arg(map, &PROGRESS_TEXT)?,
            })
        }
        ItemType::Toggle => {
            reject_foreign(map, TOGGLE_FIELDS)?;
            Ok(ItemState::Toggle {
                visible: flag(map, "visible", true)?,
                on: required_flag(map, "on")?,
                enabled: flag(map, "enabled", true)?,
            })
        }
        ItemType::Action => {
            reject_foreign(map, ACTION_FIELDS)?;
            Ok(ItemState::Action {
                visible: flag(map, "visible", true)?,
                label: optional_text_arg(map, &LABEL)?,
                enabled: flag(map, "enabled", true)?,
            })
        }
    }
}

fn chips(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(set_chips(ctx, args).map(|()| json!({})))
}

fn set_chips(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<(), ApiError> {
    let Some(Value::Array(given)) = args.get("chips") else {
        return Err(invalid("'chips' must be an array."));
    };
    if given.len() > MAX_CHIPS {
        return Err(ApiError::too_large("At most 2 chips."));
    }
    let chips = given.iter().map(chip_from).collect::<Result<Vec<_>, _>>()?;
    let event = SidebarKind::Chips {
        chips: chips.iter().map(wire).collect(),
    };
    if !ctx.api.sidebar().set_chips_serving(ctx.id, ctx.enabled, chips) {
        return Err(ApiError::unavailable());
    }
    ctx.host.emit(HostEvent::Sidebar(SidebarEvent {
        id: ctx.id.to_string(),
        kind: event,
    }));
    Ok(())
}

fn update(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(set_item(ctx, args).map(|()| json!({})))
}

fn set_item(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<(), ApiError> {
    let Some(Value::String(item_id)) = args.get("item_id") else {
        return Err(invalid("'item_id' must be a string."));
    };
    let Some(Value::Object(given)) = args.get("state") else {
        return Err(invalid("'state' must be an object."));
    };
    let decl = declaration(ctx.api, ctx.app_data, ctx.id, &ctx.serving.version)?;
    let item = decl
        .items
        .iter()
        .find(|item| item.id == *item_id)
        .ok_or_else(ApiError::not_found)?;
    let state = parse_state(item.kind, given)?;
    let event = wire(&state);
    // A plugin withdrawn while its manifest was read must not leave state behind.
    if !ctx
        .api
        .sidebar()
        .set_item_serving(ctx.id, ctx.enabled, item_id, state)
    {
        return Err(ApiError::unavailable());
    }
    ctx.host.emit(HostEvent::Sidebar(SidebarEvent {
        id: ctx.id.to_string(),
        kind: SidebarKind::Item {
            item_id: item_id.clone(),
            state: event,
        },
    }));
    Ok(())
}

/// Decides whether a click on one of `id`'s sidebar controls reaches the plugin. A toggle needs its new
/// value and an action needs none; any other item, an undeclared one, a plugin that is not serving,
/// and a click over the `Input` rate are refused. An accepted click mints one gesture bound to `id`. It
/// spends from the `Input` bucket only, never from `all`.
pub fn check_input(
    api: &ApiState,
    enabled: &EnabledSet,
    app_data: &Path,
    id: &str,
    item_id: &str,
    value: Option<bool>,
    now: Instant,
) -> SidebarInputReply {
    let refused = SidebarInputReply {
        accepted: false,
        frame: None,
    };
    let Some(serving) = enabled.serving(id) else {
        return refused;
    };
    if api.take(id, RateClass::Input, now).is_err() {
        return refused;
    }
    let Ok(decl) = declaration(api, app_data, id, &serving.version) else {
        return refused;
    };
    let Some(item) = decl.items.iter().find(|item| item.id == item_id) else {
        return refused;
    };
    let fits = matches!(
        (item.kind, value),
        (ItemType::Toggle, Some(_)) | (ItemType::Action, None)
    );
    if !fits {
        return refused;
    }
    SidebarInputReply {
        accepted: true,
        frame: Some(SidebarDelivery {
            item_id: item_id.to_string(),
            value,
            gesture: api.ui().mint(id, now),
        }),
    }
}

#[cfg(test)]
mod tests;
