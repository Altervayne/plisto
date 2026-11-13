/*
 * The `plugin.json` parser and validator: bytes in, a fully checked `Manifest` or one `ManifestError`
 * out. This is the single choke point every later trust decision rests on, so it is strict (closed
 * capability, mode, tier and sidebar vocabularies; every string capped; every path lexically safe)
 * and does no I/O. Unknown fields are ignored. A `min_plisto` above the running version is not an
 * error: the manifest parses and is flagged `Compat::NeedsNewer`.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use unicode_normalization::char::is_combining_mark;

// -- Local Imports --
use super::paths::{validate_id, validate_rel_path};
use super::semver::SemVer;
use super::sidebar_decl::{self, RawSidebar, SidebarDecl, SidebarError};

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const SUPPORTED_MANIFEST_VERSION: u64 = 1;
pub const MAX_NAME: usize = 40;
pub const MAX_AUTHOR: usize = 80;
pub const MAX_NATIVE_REASON: usize = 280;
pub const MAX_HOMEPAGE: usize = 200;
pub const MAX_ORIGINS: usize = 8;
pub const MAX_ORIGIN: usize = 128;

// -- Text checks (shared with the sidebar block) --

pub(super) enum TextProblem {
    Empty,
    TooLong,
    Control,
    Stacked,
}

/// The longest run of combining marks a display string may hold. Ordinary writing stacks two to four;
/// a longer run only serves to draw outside the line.
pub(super) const MAX_COMBINING_RUN: usize = 6;

/// Zero-width and bidi-control characters. They are invisible or reorder text, so a name could
/// otherwise read differently on the install sheet than it is stored.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}'
        | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

fn has_stacked_marks(s: &str) -> bool {
    let mut run = 0;
    for c in s.chars() {
        run = if is_combining_mark(c) { run + 1 } else { 0 };
        if run > MAX_COMBINING_RUN {
            return true;
        }
    }
    false
}

/// Checks a display string: not blank, no control characters, no long stack of combining marks, at
/// most `max` characters.
pub(super) fn text_problem(s: &str, max: usize) -> Option<TextProblem> {
    if s.trim().is_empty() {
        Some(TextProblem::Empty)
    } else if s.chars().any(|c| c.is_control() || is_invisible(c)) {
        Some(TextProblem::Control)
    } else if has_stacked_marks(s) {
        Some(TextProblem::Stacked)
    } else if s.chars().count() > max {
        Some(TextProblem::TooLong)
    } else {
        None
    }
}

// -- Vocabulary --

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Ui,
    Native,
}

impl Tier {
    fn as_str(self) -> &'static str {
        match self {
            Tier::Ui => "ui",
            Tier::Native => "native",
        }
    }

    fn entry_ext(self) -> &'static str {
        match self {
            Tier::Ui => ".html",
            Tier::Native => ".exe",
        }
    }
}

/// Which app modes show the plugin's sidebar entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeOpt {
    Player,
    Organizer,
}

/// The closed v1 capability set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Capability {
    Storage,
    LibraryRead,
    PlaybackRead,
    PlaybackControl,
    Network,
    Background,
    UiToast,
    UiConfirm,
    UiChips,
    UiSidebar,
    AudioTap,
    AudioEvents,
    AudioDevice,
    AudioOutputTakeover,
}

impl Capability {
    pub const ALL: [Capability; 14] = [
        Capability::Storage,
        Capability::LibraryRead,
        Capability::PlaybackRead,
        Capability::PlaybackControl,
        Capability::Network,
        Capability::Background,
        Capability::UiToast,
        Capability::UiConfirm,
        Capability::UiChips,
        Capability::UiSidebar,
        Capability::AudioTap,
        Capability::AudioEvents,
        Capability::AudioDevice,
        Capability::AudioOutputTakeover,
    ];

    /// The manifest spelling, also the key of the Plisto-owned review-sheet label.
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Storage => "storage",
            Capability::LibraryRead => "library.read",
            Capability::PlaybackRead => "playback.read",
            Capability::PlaybackControl => "playback.control",
            Capability::Network => "network",
            Capability::Background => "background",
            Capability::UiToast => "ui.toast",
            Capability::UiConfirm => "ui.confirm",
            Capability::UiChips => "ui.chips",
            Capability::UiSidebar => "ui.sidebar",
            Capability::AudioTap => "audio.tap",
            Capability::AudioEvents => "audio.events",
            Capability::AudioDevice => "audio.device",
            Capability::AudioOutputTakeover => "audio.output_takeover",
        }
    }

    pub fn parse(s: &str) -> Option<Capability> {
        Capability::ALL.into_iter().find(|c| c.as_str() == s)
    }

    fn is_audio(self) -> bool {
        matches!(
            self,
            Capability::AudioTap
                | Capability::AudioEvents
                | Capability::AudioDevice
                | Capability::AudioOutputTakeover
        )
    }

    fn allowed_for(self, tier: Tier) -> bool {
        match tier {
            Tier::Ui => !self.is_audio(),
            Tier::Native => self != Capability::Background,
        }
    }
}

impl Serialize for Capability {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

// -- Output --

/// Whether the running Plisto satisfies the manifest's `min_plisto`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "min_plisto")]
pub enum Compat {
    Compatible,
    NeedsNewer(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub tier: Tier,
    pub entry: String,
    pub capabilities: Vec<Capability>,
    pub min_plisto: String,
    pub author: String,
    pub homepage: Option<String>,
    pub native_reason: Option<String>,
    pub icon: Option<String>,
    pub modes: Vec<ModeOpt>,
    pub network: Vec<String>,
    pub sidebar: Option<SidebarDecl>,
    pub compat: Compat,
}

// -- Errors --

/// One variant per rejection. `Display` is the single line the hub shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    TooLarge(usize),
    Malformed(String),
    MissingField(&'static str),
    UnsupportedManifestVersion(u64),
    BadId(&'static str),
    EmptyField(&'static str),
    FieldTooLong {
        field: &'static str,
        max: usize,
    },
    ControlChars(&'static str),
    StackedMarks(&'static str),
    BadVersion {
        field: &'static str,
        value: String,
    },
    UnknownTier(String),
    BadPath {
        field: &'static str,
        reason: &'static str,
    },
    WrongEntryType {
        tier: &'static str,
        expected: &'static str,
    },
    WrongIconType,
    UnknownCapability(String),
    DuplicateCapability(String),
    CapabilityNotForTier {
        capability: &'static str,
        tier: &'static str,
    },
    UnknownMode(String),
    DuplicateMode(String),
    EmptyModes,
    BadHomepage(&'static str),
    MissingNativeReason,
    NetworkOriginsRequired,
    NetworkOriginsWithoutCapability,
    TooManyNetworkOrigins(usize),
    BadNetworkOrigin {
        origin: String,
        reason: &'static str,
    },
    DuplicateNetworkOrigin(String),
    Sidebar(SidebarError),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use ManifestError::*;
        match self {
            TooLarge(n) => write!(
                f,
                "plugin.json is {n} bytes, over the {MAX_MANIFEST_BYTES} byte limit"
            ),
            Malformed(m) => write!(f, "plugin.json is not valid: {m}"),
            MissingField(name) => write!(f, "missing required field '{name}'"),
            UnsupportedManifestVersion(v) => write!(f, "unsupported manifest_version {v}"),
            BadId(reason) => write!(f, "invalid id: {reason}"),
            EmptyField(name) => write!(f, "'{name}' must not be empty"),
            FieldTooLong { field, max } => write!(f, "'{field}' is over {max} characters"),
            ControlChars(name) => write!(f, "'{name}' contains control characters"),
            StackedMarks(name) => write!(
                f,
                "'{name}' has more than {MAX_COMBINING_RUN} combining marks in a row"
            ),
            BadVersion { field, value } => write!(f, "'{field}' is not a valid version: '{value}'"),
            UnknownTier(t) => write!(f, "unknown tier '{t}'"),
            BadPath { field, reason } => write!(f, "'{field}' {reason}"),
            WrongEntryType { tier, expected } => {
                write!(f, "a {tier} plugin's entry must be a {expected} file")
            }
            WrongIconType => write!(f, "'icon' must be a .png or .svg file"),
            UnknownCapability(c) => write!(f, "unknown capability '{c}'"),
            DuplicateCapability(c) => write!(f, "capability '{c}' is listed twice"),
            CapabilityNotForTier { capability, tier } => {
                write!(
                    f,
                    "capability '{capability}' is not available to {tier} plugins"
                )
            }
            UnknownMode(m) => write!(f, "unknown mode '{m}'"),
            DuplicateMode(m) => write!(f, "mode '{m}' is listed twice"),
            EmptyModes => write!(f, "'modes' must list at least one mode"),
            BadHomepage(reason) => write!(f, "'homepage' {reason}"),
            MissingNativeReason => write!(f, "a native plugin must give 'native_reason'"),
            NetworkOriginsRequired => {
                write!(
                    f,
                    "the 'network' capability requires a non-empty 'network' origin list"
                )
            }
            NetworkOriginsWithoutCapability => {
                write!(
                    f,
                    "'network' origins are only allowed with the 'network' capability"
                )
            }
            TooManyNetworkOrigins(n) => {
                write!(
                    f,
                    "'network' lists {n} origins, over the limit of {MAX_ORIGINS}"
                )
            }
            BadNetworkOrigin { origin, reason } => write!(f, "network origin '{origin}' {reason}"),
            DuplicateNetworkOrigin(o) => write!(f, "network origin '{o}' is listed twice"),
            Sidebar(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ManifestError {}

impl From<SidebarError> for ManifestError {
    fn from(e: SidebarError) -> Self {
        ManifestError::Sidebar(e)
    }
}

// -- Parsing --

#[derive(Deserialize)]
struct RawManifest {
    manifest_version: Option<u64>,
    id: Option<String>,
    name: Option<String>,
    version: Option<String>,
    tier: Option<String>,
    entry: Option<String>,
    capabilities: Option<Vec<String>>,
    min_plisto: Option<String>,
    author: Option<String>,
    homepage: Option<String>,
    native_reason: Option<String>,
    icon: Option<String>,
    modes: Option<Vec<String>>,
    network: Option<Vec<String>>,
    sidebar: Option<RawSidebar>,
}

fn require<T>(v: Option<T>, name: &'static str) -> Result<T, ManifestError> {
    v.ok_or(ManifestError::MissingField(name))
}

fn check_text(s: &str, field: &'static str, max: usize) -> Result<(), ManifestError> {
    match text_problem(s, max) {
        Some(TextProblem::Empty) => Err(ManifestError::EmptyField(field)),
        Some(TextProblem::Control) => Err(ManifestError::ControlChars(field)),
        Some(TextProblem::Stacked) => Err(ManifestError::StackedMarks(field)),
        Some(TextProblem::TooLong) => Err(ManifestError::FieldTooLong { field, max }),
        None => Ok(()),
    }
}

fn check_path(s: &str, field: &'static str) -> Result<(), ManifestError> {
    validate_rel_path(s).map_err(|reason| ManifestError::BadPath { field, reason })
}

fn has_ext(path: &str, ext: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("");
    name.len() > ext.len() && name.to_ascii_lowercase().ends_with(ext)
}

fn homepage_problem(url: &str) -> Option<&'static str> {
    if url.len() > MAX_HOMEPAGE {
        return Some("is too long");
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return Some("must be an https URL");
    };
    if rest.is_empty() || rest.starts_with('/') {
        return Some("must name a host");
    }
    if !url.bytes().all(|b| {
        (0x21..=0x7e).contains(&b) && !matches!(b, b'"' | b'\'' | b'<' | b'>' | b'\\' | b'`')
    }) {
        return Some("contains characters that are not allowed in a URL");
    }
    None
}

fn origin_problem(origin: &str) -> Option<&'static str> {
    if origin.len() > MAX_ORIGIN {
        return Some("is too long");
    }
    let Some(rest) = origin.strip_prefix("https://") else {
        return Some("must start with https://");
    };
    if rest.contains('*') {
        return Some("must not use wildcards");
    }
    if rest.contains('@') {
        return Some("must not carry credentials");
    }
    if rest.contains(['/', '?', '#']) {
        return Some("must be a bare origin without a path, query or fragment");
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    if let Some(p) = port {
        let valid = !p.is_empty()
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u16>().map_or(false, |n| n != 0);
        if !valid {
            return Some("has an invalid port");
        }
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    if labels.len() < 2 || !labels.iter().all(label_ok) {
        return Some("must be a lowercase DNS host name");
    }
    // Browsers read a host whose last label is a number in any radix (0x7f, 017) as IPv4, so a real
    // TLD (alphabetic, or xn--) is required.
    if !labels[labels.len() - 1].starts_with(|c: char| c.is_ascii_lowercase()) {
        return Some("must not be an IP address");
    }
    None
}

// The origin list feeds the frame's connect-src, so it exists exactly when the capability does.
fn validate_network(
    origins: Option<Vec<String>>,
    caps: &[Capability],
) -> Result<Vec<String>, ManifestError> {
    let wants = caps.contains(&Capability::Network);
    let origins = origins.unwrap_or_default();
    match (wants, origins.is_empty()) {
        (true, true) => return Err(ManifestError::NetworkOriginsRequired),
        (false, false) => return Err(ManifestError::NetworkOriginsWithoutCapability),
        _ => {}
    }
    if origins.len() > MAX_ORIGINS {
        return Err(ManifestError::TooManyNetworkOrigins(origins.len()));
    }
    let mut seen = HashSet::new();
    for origin in &origins {
        if let Some(reason) = origin_problem(origin) {
            return Err(ManifestError::BadNetworkOrigin {
                origin: clip(origin),
                reason,
            });
        }
        if !seen.insert(origin.as_str()) {
            return Err(ManifestError::DuplicateNetworkOrigin(origin.clone()));
        }
    }
    Ok(origins)
}

// Audio is native-only and background is UI-only; the sidebar block checks its own needs later.
fn validate_capabilities(raw: Vec<String>, tier: Tier) -> Result<Vec<Capability>, ManifestError> {
    let mut caps = Vec::with_capacity(raw.len());
    for name in raw {
        let cap = Capability::parse(&name)
            .ok_or_else(|| ManifestError::UnknownCapability(clip(&name)))?;
        if caps.contains(&cap) {
            return Err(ManifestError::DuplicateCapability(name));
        }
        if !cap.allowed_for(tier) {
            return Err(ManifestError::CapabilityNotForTier {
                capability: cap.as_str(),
                tier: tier.as_str(),
            });
        }
        caps.push(cap);
    }
    Ok(caps)
}

fn validate_modes(raw: Option<Vec<String>>) -> Result<Vec<ModeOpt>, ManifestError> {
    // Absent means player-only: the plugin stays out of Organizer mode unless it opts in.
    let Some(raw) = raw else {
        return Ok(vec![ModeOpt::Player]);
    };
    if raw.is_empty() {
        return Err(ManifestError::EmptyModes);
    }
    let mut modes = Vec::with_capacity(raw.len());
    for name in raw {
        let mode = match name.as_str() {
            "player" => ModeOpt::Player,
            "organizer" => ModeOpt::Organizer,
            _ => return Err(ManifestError::UnknownMode(clip(&name))),
        };
        if modes.contains(&mode) {
            return Err(ManifestError::DuplicateMode(name));
        }
        modes.push(mode);
    }
    Ok(modes)
}

fn malformed(e: serde_json::Error) -> ManifestError {
    let msg: String = e
        .to_string()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(160)
        .collect();
    ManifestError::Malformed(msg)
}

/// Parses and validates `plugin.json` bytes against the running Plisto version.
pub fn parse(bytes: &[u8]) -> Result<Manifest, ManifestError> {
    // The crate version is always valid semver; if it ever were not, nothing is flagged incompatible.
    let running = SemVer::parse(env!("CARGO_PKG_VERSION"));
    parse_against(bytes, running.as_ref())
}

/// `parse` with the running version injected, so compatibility is testable.
pub fn parse_against(bytes: &[u8], running: Option<&SemVer>) -> Result<Manifest, ManifestError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestError::TooLarge(bytes.len()));
    }
    // Editors on Windows often save a UTF-8 BOM, which serde_json rejects.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let raw: RawManifest = serde_json::from_slice(bytes).map_err(malformed)?;

    let mv = require(raw.manifest_version, "manifest_version")?;
    if mv != SUPPORTED_MANIFEST_VERSION {
        return Err(ManifestError::UnsupportedManifestVersion(mv));
    }

    let id = require(raw.id, "id")?;
    validate_id(&id).map_err(ManifestError::BadId)?;

    let name = require(raw.name, "name")?;
    check_text(&name, "name", MAX_NAME)?;

    let version = require(raw.version, "version")?;
    if SemVer::parse(&version).is_none() {
        return Err(ManifestError::BadVersion {
            field: "version",
            value: clip(&version),
        });
    }

    let tier = match require(raw.tier, "tier")?.as_str() {
        "ui" => Tier::Ui,
        "native" => Tier::Native,
        other => return Err(ManifestError::UnknownTier(clip(other))),
    };

    let entry = require(raw.entry, "entry")?;
    check_path(&entry, "entry")?;
    if !has_ext(&entry, tier.entry_ext()) {
        return Err(ManifestError::WrongEntryType {
            tier: tier.as_str(),
            expected: tier.entry_ext(),
        });
    }

    let capabilities = validate_capabilities(require(raw.capabilities, "capabilities")?, tier)?;

    let min_plisto = require(raw.min_plisto, "min_plisto")?;
    let min = SemVer::parse(&min_plisto).ok_or_else(|| ManifestError::BadVersion {
        field: "min_plisto",
        value: clip(&min_plisto),
    })?;

    let author = require(raw.author, "author")?;
    check_text(&author, "author", MAX_AUTHOR)?;

    if let Some(url) = &raw.homepage {
        if let Some(reason) = homepage_problem(url) {
            return Err(ManifestError::BadHomepage(reason));
        }
    }

    let native_reason = match tier {
        Tier::Native => {
            let reason = raw
                .native_reason
                .ok_or(ManifestError::MissingNativeReason)?;
            check_text(&reason, "native_reason", MAX_NATIVE_REASON)?;
            Some(reason)
        }
        // A UI plugin has no native justification to show; a stray value is dropped.
        Tier::Ui => None,
    };

    if let Some(icon) = &raw.icon {
        check_path(icon, "icon")?;
        if !has_ext(icon, ".png") && !has_ext(icon, ".svg") {
            return Err(ManifestError::WrongIconType);
        }
    }

    let modes = validate_modes(raw.modes)?;
    let network = validate_network(raw.network, &capabilities)?;
    let sidebar = match raw.sidebar {
        Some(block) => Some(sidebar_decl::validate(block, tier, &capabilities)?),
        None => None,
    };

    let compat = match running {
        Some(r) if min > *r => Compat::NeedsNewer(min_plisto.clone()),
        _ => Compat::Compatible,
    };

    Ok(Manifest {
        id,
        name,
        version,
        tier,
        entry,
        capabilities,
        min_plisto,
        author,
        homepage: raw.homepage,
        native_reason,
        icon: raw.icon,
        modes,
        network,
        sidebar,
        compat,
    })
}

// Echoed values are clipped so an error line stays one short line.
pub(super) fn clip(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

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
            assert!(
                run(&with(native(), "capabilities", json!([cap]))).is_ok(),
                "{cap} native"
            );
        }
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
        for tier in [ui(), native()] {
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
        for origin in [
            "http://api.example.com",
            "api.example.com",
            "https://*.example.com",
            "https://*",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com/",
            "https://example.com?x=1",
            "https://example.com#f",
            "https://example.com:0",
            "https://example.com:99999",
            "https://example.com:",
            "https://example.com:80a",
            "https://localhost",
            "https://127.0.0.1",
            "https://1.2.3.4:8080",
            "https://Example.com",
            "https://exa mple.com",
            "https://-a.example.com",
            "https://a..example.com",
            "https://example.com;x",
            "https://[::1]",
        ] {
            assert!(
                matches!(
                    run(&with(v.clone(), "network", json!([origin]))),
                    Err(ManifestError::BadNetworkOrigin { .. })
                ),
                "{origin}"
            );
        }
        let long = format!("https://{}.example.com", "a".repeat(MAX_ORIGIN));
        assert!(matches!(
            run(&with(v, "network", json!([long]))),
            Err(ManifestError::BadNetworkOrigin { .. })
        ));
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
        assert!(matches!(text_problem(&over, 60), Some(TextProblem::Stacked)));
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
}
