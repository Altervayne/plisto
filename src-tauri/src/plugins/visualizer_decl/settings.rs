/*
 * The settings and presets a visualizer kind declares. A setting is one control in the Player's
 * sheet footer; a preset is a named bundle of setting values shown as one more choice. A setting
 * without a `default` starts at its first option, off, its minimum, or the cover palette.
 */

// -- Library Imports --
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// -- Local Imports --
use super::{bad, check_label, clip, valid_kind_id, VisualizerError, ID_RULE};

pub const MAX_SETTINGS: usize = 8;
pub const MAX_PRESETS: usize = 6;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChoiceOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum SettingKind {
    Choice { options: Vec<ChoiceOption> },
    Toggle,
    Range { min: f64, max: f64, step: f64 },
    /// A `#rrggbb` color, or `cover` for the cover palette.
    Color,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SettingValue {
    Flag(bool),
    Number(f64),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SettingDecl {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub kind: SettingKind,
    pub default: SettingValue,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PresetDecl {
    pub id: String,
    pub label: String,
    pub values: BTreeMap<String, SettingValue>,
}

#[derive(Deserialize)]
pub(super) struct RawOption {
    id: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct RawSetting {
    id: Option<String>,
    label: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    options: Option<Vec<RawOption>>,
    min: Option<f64>,
    max: Option<f64>,
    step: Option<f64>,
    default: Option<Value>,
}

#[derive(Deserialize)]
pub(super) struct RawPreset {
    id: Option<String>,
    label: Option<String>,
    values: Option<Map<String, Value>>,
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7
        && s.starts_with('#')
        && s.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
}

impl SettingKind {
    /// The value as this setting holds it, or None when the setting cannot take it.
    pub fn accepts(&self, value: &Value) -> Option<SettingValue> {
        match (self, value) {
            (SettingKind::Choice { options }, Value::String(s)) => options
                .iter()
                .any(|o| o.id == *s)
                .then(|| SettingValue::Text(s.clone())),
            (SettingKind::Toggle, Value::Bool(b)) => Some(SettingValue::Flag(*b)),
            (SettingKind::Range { min, max, .. }, Value::Number(n)) => n
                .as_f64()
                .filter(|x| (*min..=*max).contains(x))
                .map(SettingValue::Number),
            (SettingKind::Color, Value::String(s)) if s == "cover" || is_hex_color(s) => {
                Some(SettingValue::Text(s.clone()))
            }
            _ => None,
        }
    }

    fn fallback(&self) -> SettingValue {
        match self {
            SettingKind::Choice { options } => SettingValue::Text(options[0].id.clone()),
            SettingKind::Toggle => SettingValue::Flag(false),
            SettingKind::Range { min, .. } => SettingValue::Number(*min),
            SettingKind::Color => SettingValue::Text("cover".to_string()),
        }
    }
}

/// Checks an id inside a kind: the kind-id rule, and not already in `taken`.
fn check_inner_id(
    kind: &str,
    field: &str,
    id: Option<String>,
    taken: &mut HashSet<String>,
) -> Result<String, VisualizerError> {
    let id = id.ok_or_else(|| bad(kind, format!("{field}.id"), "is missing"))?;
    if !valid_kind_id(&id) {
        return Err(bad(kind, format!("{field}.id"), ID_RULE));
    }
    if !taken.insert(id.clone()) {
        return Err(bad(kind, format!("{field}.{id}"), "is listed twice"));
    }
    Ok(id)
}

fn check_label_at(
    kind: &str,
    field: &str,
    label: Option<String>,
) -> Result<String, VisualizerError> {
    let label = label.ok_or_else(|| bad(kind, format!("{field}.label"), "is missing"))?;
    check_label(&label).map_err(|reason| bad(kind, format!("{field}.label"), reason))?;
    Ok(label)
}

fn parse_options(
    kind: &str,
    field: &str,
    raw: Option<Vec<RawOption>>,
) -> Result<Vec<ChoiceOption>, VisualizerError> {
    let raw = raw.unwrap_or_default();
    if raw.len() < MIN_OPTIONS || raw.len() > MAX_OPTIONS {
        return Err(bad(kind, format!("{field}.options"), "must list 2 to 8 options"));
    }
    let mut taken = HashSet::new();
    let mut options = Vec::with_capacity(raw.len());
    for (i, option) in raw.into_iter().enumerate() {
        let at = format!("{field}.options.{}", i + 1);
        let id = check_inner_id(kind, &at, option.id, &mut taken)?;
        let label = check_label_at(kind, &at, option.label)?;
        options.push(ChoiceOption { id, label });
    }
    Ok(options)
}

fn parse_range(kind: &str, field: &str, raw: &RawSetting) -> Result<SettingKind, VisualizerError> {
    let (Some(min), Some(max), Some(step)) = (raw.min, raw.max, raw.step) else {
        return Err(bad(kind, field, "is a range and must give 'min', 'max' and 'step'"));
    };
    if min >= max {
        return Err(bad(kind, format!("{field}.min"), "must be below 'max'"));
    }
    if step <= 0.0 || step > max - min {
        return Err(bad(kind, format!("{field}.step"), "must be above 0 and within the range"));
    }
    Ok(SettingKind::Range { min, max, step })
}

fn parse_kind(
    kind: &str,
    field: &str,
    raw: &mut RawSetting,
) -> Result<SettingKind, VisualizerError> {
    let type_name = raw.kind.take();
    let type_name = type_name.ok_or_else(|| bad(kind, format!("{field}.type"), "is missing"))?;
    let is_range = type_name == "range";
    if type_name != "choice" && raw.options.is_some() {
        return Err(bad(kind, format!("{field}.options"), "is only for a choice setting"));
    }
    if !is_range && (raw.min.is_some() || raw.max.is_some() || raw.step.is_some()) {
        return Err(bad(kind, field, "gives 'min', 'max' or 'step' but is not a range"));
    }
    match type_name.as_str() {
        "choice" => Ok(SettingKind::Choice {
            options: parse_options(kind, field, raw.options.take())?,
        }),
        "toggle" => Ok(SettingKind::Toggle),
        "range" => parse_range(kind, field, raw),
        "color" => Ok(SettingKind::Color),
        _ => Err(bad(
            kind,
            format!("{field}.type"),
            "must be choice, toggle, range or color",
        )),
    }
}

pub(super) fn validate_settings(
    kind: &str,
    raw: Vec<RawSetting>,
) -> Result<Vec<SettingDecl>, VisualizerError> {
    if raw.len() > MAX_SETTINGS {
        return Err(VisualizerError::TooMany {
            kind: kind.to_string(),
            field: "settings",
            max: MAX_SETTINGS,
        });
    }
    let mut taken = HashSet::new();
    let mut settings = Vec::with_capacity(raw.len());
    for (i, mut setting) in raw.into_iter().enumerate() {
        let at = format!("settings.{}", i + 1);
        let id = check_inner_id(kind, &at, setting.id.take(), &mut taken)?;
        let field = format!("settings.{id}");
        let label = check_label_at(kind, &field, setting.label.take())?;
        let setting_kind = parse_kind(kind, &field, &mut setting)?;
        let default = match &setting.default {
            None => setting_kind.fallback(),
            Some(value) => setting_kind
                .accepts(value)
                .ok_or_else(|| bad(kind, format!("{field}.default"), "is not a value it takes"))?,
        };
        settings.push(SettingDecl {
            id,
            label,
            kind: setting_kind,
            default,
        });
    }
    Ok(settings)
}

pub(super) fn validate_presets(
    kind: &str,
    raw: Vec<RawPreset>,
    settings: &[SettingDecl],
) -> Result<Vec<PresetDecl>, VisualizerError> {
    if raw.len() > MAX_PRESETS {
        return Err(VisualizerError::TooMany {
            kind: kind.to_string(),
            field: "presets",
            max: MAX_PRESETS,
        });
    }
    let mut taken = HashSet::new();
    let mut presets = Vec::with_capacity(raw.len());
    for (i, preset) in raw.into_iter().enumerate() {
        let id = check_inner_id(kind, &format!("presets.{}", i + 1), preset.id, &mut taken)?;
        let field = format!("presets.{id}");
        let label = check_label_at(kind, &field, preset.label)?;
        let raw_values = preset.values.unwrap_or_default();
        if raw_values.is_empty() {
            return Err(bad(kind, format!("{field}.values"), "must set at least one setting"));
        }
        let mut values = BTreeMap::new();
        for (key, value) in raw_values {
            let at = format!("{field}.values.{}", clip(&key));
            let setting = settings
                .iter()
                .find(|s| s.id == key)
                .ok_or_else(|| bad(kind, at.clone(), "names no setting of this visualizer"))?;
            let value = setting
                .kind
                .accepts(&value)
                .ok_or_else(|| bad(kind, at, "is not a value that setting takes"))?;
            values.insert(key, value);
        }
        presets.push(PresetDecl { id, label, values });
    }
    Ok(presets)
}
