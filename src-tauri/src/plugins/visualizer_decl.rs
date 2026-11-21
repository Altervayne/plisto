/*
 * The optional `visualizers` block of a plugin manifest: the visualizer kinds a plugin adds to the
 * Player. Pure validation, plus `check_files` for the file each kind names. The block and the
 * `visualizer` capability come together, so a plugin never asks to draw without declaring what it
 * draws. Composite and blend are kept apart: the composite is how Plisto's runtime tone-maps the
 * scene, the blend is the CSS blend Plisto puts on the slot.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// -- Local Imports --
use super::manifest::{clip, has_ext, text_problem, Capability, TextProblem};
use super::paths::validate_rel_path;
use super::revalidate::plain_file;

mod settings;

pub use settings::{PresetDecl, SettingDecl};
use settings::{validate_presets, validate_settings, RawPreset, RawSetting};

pub const MAX_VISUALIZERS: usize = 8;
pub const MAX_KIND_ID: usize = 24;
pub const MAX_LABEL: usize = 24;
pub const MAX_ALIASES: usize = 4;
pub const SUPPORTED_API: u64 = 1;

const ID_RULE: &str = "must be 1 to 24 characters of a-z, 0-9 and '-'";
const LOOK_SHAPE: &str = "must be \"glow\", \"image\" or a 'light' and 'dark' pair";

// The CSS mix-blend-mode keywords. The blend lands in the slot's style, so nothing else passes.
const BLENDS: &[&str] = &[
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
    "plus-lighter",
];

/// How the runtime tone-maps a scene onto the stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Composite {
    Light,
    Ink,
    Image,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LookPair {
    pub composite: Composite,
    pub blend: String,
}

/// The composite and blend per theme. The `glow` and `image` shorthands arrive expanded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Look {
    pub light: LookPair,
    pub dark: LookPair,
}

/// What a kind asks Plisto to feed it beyond the levels. Each defaults to false.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Needs {
    pub fine: bool,
    pub cover: bool,
    pub pointer: bool,
    pub waveform: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VisualizerDecl {
    pub id: String,
    pub name: String,
    pub api: u64,
    /// The page the visualizer frame loads; null for a shader kind.
    pub page: Option<String>,
    /// The fragment shader Plisto's shader page runs; null for a page kind.
    pub shader: Option<String>,
    pub look: Look,
    pub fills_stage: bool,
    pub dark_only: bool,
    pub needs: Needs,
    /// Former ids. A stored pick naming one resolves to this kind.
    pub aliases: Vec<String>,
    pub settings: Vec<SettingDecl>,
    pub presets: Vec<PresetDecl>,
}

#[derive(Deserialize)]
pub(super) struct RawVisualizer {
    id: Option<String>,
    name: Option<String>,
    api: Option<u64>,
    page: Option<String>,
    shader: Option<String>,
    look: Option<Value>,
    fills_stage: Option<bool>,
    dark_only: Option<bool>,
    needs: Option<Needs>,
    aliases: Option<Vec<String>>,
    settings: Option<Vec<RawSetting>>,
    presets: Option<Vec<RawPreset>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisualizerError {
    NeedsCapability,
    NoVisualizers,
    WaveformNeedsVisualizer,
    Count(usize),
    MissingField { index: usize, field: &'static str },
    BadId(String),
    /// An id or alias that another kind of the plugin, or the same one, already uses.
    DuplicateId(String),
    UnsupportedApi { kind: String, api: u64 },
    Source(String),
    NeedsWaveform(String),
    TooMany { kind: String, field: &'static str, max: usize },
    /// One field of a kind holds a value that is refused. `field` is its path inside the kind.
    Field { kind: String, field: String, reason: &'static str },
}

impl fmt::Display for VisualizerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use VisualizerError::*;
        match self {
            NeedsCapability => {
                write!(f, "a 'visualizers' block requires the 'visualizer' capability")
            }
            NoVisualizers => {
                write!(f, "the 'visualizer' capability requires a 'visualizers' block")
            }
            WaveformNeedsVisualizer => write!(
                f,
                "the 'visualizer.waveform' capability requires the 'visualizer' capability"
            ),
            Count(n) => write!(
                f,
                "'visualizers' must list 1 to {MAX_VISUALIZERS} visualizers, found {n}"
            ),
            MissingField { index, field } => {
                write!(f, "visualizer {} is missing '{field}'", index + 1)
            }
            BadId(id) => write!(f, "visualizer id '{id}' {ID_RULE}"),
            DuplicateId(id) => write!(f, "visualizer id or alias '{id}' is used twice"),
            UnsupportedApi { kind, api } => write!(
                f,
                "visualizer '{kind}' asks for api {api}; this Plisto runs api {SUPPORTED_API}"
            ),
            Source(kind) => {
                write!(f, "visualizer '{kind}' must give exactly one of 'page' or 'shader'")
            }
            NeedsWaveform(kind) => write!(
                f,
                "visualizer '{kind}' needs the waveform, which requires 'visualizer.waveform'"
            ),
            TooMany { kind, field, max } => {
                write!(f, "visualizer '{kind}' lists more than {max} {field}")
            }
            Field {
                kind,
                field,
                reason,
            } => write!(f, "visualizer '{kind}': '{field}' {reason}"),
        }
    }
}

/// A file a visualizer names is missing or not a plain file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingFile {
    pub kind: String,
    pub field: &'static str,
}

impl fmt::Display for MissingFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the file named by '{}' of visualizer '{}' is missing",
            self.field, self.kind
        )
    }
}

pub(super) fn bad(kind: &str, field: impl Into<String>, reason: &'static str) -> VisualizerError {
    VisualizerError::Field {
        kind: kind.to_string(),
        field: field.into(),
        reason,
    }
}

pub(super) fn valid_kind_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_KIND_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Checks a name or label Plisto shows: 1 to `MAX_LABEL` characters of plain text.
pub(super) fn check_label(s: &str) -> Result<(), &'static str> {
    match text_problem(s, MAX_LABEL) {
        Some(TextProblem::Empty) => Err("must not be empty"),
        Some(TextProblem::Control) => Err("contains control characters"),
        Some(TextProblem::Stacked) => Err("has too many combining marks in a row"),
        Some(TextProblem::TooLong) => Err("is over 24 characters"),
        None => Ok(()),
    }
}

fn check_file(path: &str, exts: &[&str], wrong_type: &'static str) -> Result<(), &'static str> {
    validate_rel_path(path)?;
    if !exts.iter().any(|ext| has_ext(path, ext)) {
        return Err(wrong_type);
    }
    Ok(())
}

fn look_pair(composite: Composite, blend: &str) -> LookPair {
    LookPair {
        composite,
        blend: blend.to_string(),
    }
}

fn parse_pair(theme: Option<&Value>) -> Result<LookPair, &'static str> {
    let pair = theme.and_then(Value::as_object).ok_or(LOOK_SHAPE)?;
    let composite = match pair.get("composite").and_then(Value::as_str) {
        Some("light") => Composite::Light,
        Some("ink") => Composite::Ink,
        Some("image") => Composite::Image,
        _ => return Err("has a composite that is not light, ink or image"),
    };
    let blend = pair
        .get("blend")
        .and_then(Value::as_str)
        .filter(|b| BLENDS.contains(b))
        .ok_or("has a blend that is not a CSS mix-blend-mode keyword")?;
    Ok(look_pair(composite, blend))
}

fn parse_look(look: &Value) -> Result<Look, &'static str> {
    match look {
        Value::String(s) if s == "glow" => Ok(Look {
            light: look_pair(Composite::Ink, "multiply"),
            dark: look_pair(Composite::Light, "screen"),
        }),
        Value::String(s) if s == "image" => Ok(Look {
            light: look_pair(Composite::Image, "normal"),
            dark: look_pair(Composite::Image, "normal"),
        }),
        Value::Object(pairs) => look_of(pairs),
        _ => Err(LOOK_SHAPE),
    }
}

fn look_of(pairs: &Map<String, Value>) -> Result<Look, &'static str> {
    Ok(Look {
        light: parse_pair(pairs.get("light"))?,
        dark: parse_pair(pairs.get("dark"))?,
    })
}

fn validate_one(
    index: usize,
    raw: RawVisualizer,
    caps: &[Capability],
) -> Result<VisualizerDecl, VisualizerError> {
    let missing = |field| VisualizerError::MissingField { index, field };
    let id = raw.id.ok_or_else(|| missing("id"))?;
    if !valid_kind_id(&id) {
        return Err(VisualizerError::BadId(clip(&id)));
    }
    let name = raw.name.ok_or_else(|| missing("name"))?;
    check_label(&name).map_err(|reason| bad(&id, "name", reason))?;
    let api = raw.api.ok_or_else(|| missing("api"))?;
    if api != SUPPORTED_API {
        return Err(VisualizerError::UnsupportedApi { kind: id, api });
    }
    match (&raw.page, &raw.shader) {
        (Some(page), None) => check_file(page, &[".html"], "must be a .html file")
            .map_err(|reason| bad(&id, "page", reason))?,
        (None, Some(shader)) => {
            check_file(shader, &[".frag", ".glsl"], "must be a .frag or .glsl file")
                .map_err(|reason| bad(&id, "shader", reason))?
        }
        _ => return Err(VisualizerError::Source(id)),
    }
    let look = raw.look.ok_or_else(|| missing("look"))?;
    let look = parse_look(&look).map_err(|reason| bad(&id, "look", reason))?;
    let needs = raw.needs.unwrap_or_default();
    if needs.waveform && !caps.contains(&Capability::VisualizerWaveform) {
        return Err(VisualizerError::NeedsWaveform(id));
    }
    let aliases = raw.aliases.unwrap_or_default();
    if aliases.len() > MAX_ALIASES {
        return Err(VisualizerError::TooMany {
            kind: id,
            field: "aliases",
            max: MAX_ALIASES,
        });
    }
    if let Some(alias) = aliases.iter().find(|a| !valid_kind_id(a)) {
        return Err(bad(&id, format!("aliases.{}", clip(alias)), ID_RULE));
    }
    let settings = validate_settings(&id, raw.settings.unwrap_or_default())?;
    let presets = validate_presets(&id, raw.presets.unwrap_or_default(), &settings)?;
    Ok(VisualizerDecl {
        id,
        name,
        api,
        page: raw.page,
        shader: raw.shader,
        look,
        fills_stage: raw.fills_stage.unwrap_or(false),
        dark_only: raw.dark_only.unwrap_or(false),
        needs,
        aliases,
        settings,
        presets,
    })
}

/// Validates the block against the plugin's capabilities. Ids and aliases share one namespace
/// across the plugin's kinds, so a stored pick always resolves to exactly one kind.
pub(super) fn validate(
    raw: Option<Vec<RawVisualizer>>,
    caps: &[Capability],
) -> Result<Vec<VisualizerDecl>, VisualizerError> {
    let draws = caps.contains(&Capability::Visualizer);
    if caps.contains(&Capability::VisualizerWaveform) && !draws {
        return Err(VisualizerError::WaveformNeedsVisualizer);
    }
    let raw = match (raw, draws) {
        (None, false) => return Ok(Vec::new()),
        (None, true) => return Err(VisualizerError::NoVisualizers),
        (Some(_), false) => return Err(VisualizerError::NeedsCapability),
        (Some(raw), true) => raw,
    };
    if raw.is_empty() || raw.len() > MAX_VISUALIZERS {
        return Err(VisualizerError::Count(raw.len()));
    }
    let mut taken = HashSet::new();
    let mut decls = Vec::with_capacity(raw.len());
    for (index, item) in raw.into_iter().enumerate() {
        let decl = validate_one(index, item, caps)?;
        for id in std::iter::once(&decl.id).chain(&decl.aliases) {
            if !taken.insert(id.clone()) {
                return Err(VisualizerError::DuplicateId(id.clone()));
            }
        }
        decls.push(decl);
    }
    Ok(decls)
}

/// Checks that the page or shader of every kind is a plain file inside `dir`, reached through plain
/// folders only.
pub fn check_files(dir: &Path, decls: &[VisualizerDecl]) -> Result<(), MissingFile> {
    for decl in decls {
        for (field, file) in [("page", &decl.page), ("shader", &decl.shader)] {
            if file.as_ref().is_some_and(|file| !plain_file(dir, file)) {
                return Err(MissingFile {
                    kind: decl.id.clone(),
                    field,
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
