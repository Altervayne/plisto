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
use super::visualizer_decl::{self, RawVisualizer, VisualizerDecl, VisualizerError};

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
    PlaybackStream,
    Visualizer,
    VisualizerWaveform,
}

impl Capability {
    pub const ALL: [Capability; 17] = [
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
        Capability::PlaybackStream,
        Capability::Visualizer,
        Capability::VisualizerWaveform,
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
            Capability::PlaybackStream => "playback.stream",
            Capability::Visualizer => "visualizer",
            Capability::VisualizerWaveform => "visualizer.waveform",
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub tier: Tier,
    /// Absent only for a UI plugin that only adds visualizers.
    pub entry: Option<String>,
    /// A native plugin's own HTML page; a UI plugin's page is its `entry`.
    pub page: Option<String>,
    pub capabilities: Vec<Capability>,
    pub min_plisto: String,
    pub author: String,
    pub homepage: Option<String>,
    pub native_reason: Option<String>,
    pub icon: Option<String>,
    pub modes: Vec<ModeOpt>,
    pub network: Vec<String>,
    pub sidebar: Option<SidebarDecl>,
    pub visualizers: Vec<VisualizerDecl>,
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
    PaddedField(&'static str),
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
    WrongPageType,
    WrongIconType,
    MissingPage,
    DeviceNeedsEvents,
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
    Visualizer(VisualizerError),
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
            PaddedField(name) => write!(f, "'{name}' must not start or end with a space"),
            BadVersion { field, value } => write!(f, "'{field}' is not a valid version: '{value}'"),
            UnknownTier(t) => write!(f, "unknown tier '{t}'"),
            BadPath { field, reason } => write!(f, "'{field}' {reason}"),
            WrongEntryType { tier, expected } => {
                write!(f, "a {tier} plugin's entry must be a {expected} file")
            }
            WrongPageType => write!(f, "'page' must be a .html file"),
            WrongIconType => write!(f, "'icon' must be a .png or .svg file"),
            MissingPage => write!(
                f,
                "a native plugin with a sidebar 'nav' item must give 'page', the page the item opens"
            ),
            DeviceNeedsEvents => write!(
                f,
                "the 'audio.device' capability requires 'audio.events', the only place the device is reported"
            ),
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
            Visualizer(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ManifestError {}

impl From<SidebarError> for ManifestError {
    fn from(e: SidebarError) -> Self {
        ManifestError::Sidebar(e)
    }
}

impl From<VisualizerError> for ManifestError {
    fn from(e: VisualizerError) -> Self {
        ManifestError::Visualizer(e)
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
    page: Option<String>,
    capabilities: Option<Vec<String>>,
    min_plisto: Option<String>,
    author: Option<String>,
    homepage: Option<String>,
    native_reason: Option<String>,
    icon: Option<String>,
    modes: Option<Vec<String>>,
    network: Option<Vec<String>>,
    sidebar: Option<RawSidebar>,
    visualizers: Option<Vec<RawVisualizer>>,
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

/// `check_text` for a name the sheet shows as who the plugin is. Surrounding whitespace is refused, so
/// two values that look the same are the same.
fn check_identity(s: &str, field: &'static str, max: usize) -> Result<(), ManifestError> {
    check_text(s, field, max)?;
    if s.trim() != s {
        return Err(ManifestError::PaddedField(field));
    }
    Ok(())
}

fn check_path(s: &str, field: &'static str) -> Result<(), ManifestError> {
    validate_rel_path(s).map_err(|reason| ManifestError::BadPath { field, reason })
}

pub(super) fn has_ext(path: &str, ext: &str) -> bool {
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

// Last labels that never resolve on the public internet. Closed list: a name outside it is not refused.
const RESERVED_TLDS: [&str; 13] = [
    "localhost",
    "invalid",
    "test",
    "example",
    "local",
    "internal",
    "arpa",
    "onion",
    "home",
    "lan",
    "corp",
    "intranet",
    "localdomain",
];

const MAX_LABEL: usize = 63;

/// How a network origin is reached: a public https host, or a developer's own machine over http.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OriginKind {
    Public,
    DevLoopback,
}

const NOT_DEV_ADDRESS: &str =
    "is not a development address Plisto accepts (use http://127.0.0.1:<port>)";

/// Classifies a declared network origin, or names why it is refused.
pub(super) fn origin_kind(origin: &str) -> Result<OriginKind, &'static str> {
    if origin.len() > MAX_ORIGIN {
        return Err("is too long");
    }
    if let Some(rest) = origin.strip_prefix("http://") {
        return dev_loopback(rest);
    }
    match public_origin_problem(origin) {
        Some(reason) => Err(reason),
        None => Ok(OriginKind::Public),
    }
}

// Only http://127.0.0.1:<port> and http://localhost:<port> are accepted over http. A loopback-looking
// near miss gets the specific reason; any other http host falls through to the https requirement.
fn dev_loopback(rest: &str) -> Result<OriginKind, &'static str> {
    let host = rest.split(['/', '?', '#', ':']).next().unwrap_or("");
    let loopback_like = rest.starts_with('[')
        || host == "localhost"
        || host == "0.0.0.0"
        || host.starts_with("127.");
    if !loopback_like {
        return Err("must start with https://");
    }
    let port = rest
        .strip_prefix("127.0.0.1:")
        .or_else(|| rest.strip_prefix("localhost:"));
    let valid = port.is_some_and(|p| {
        !p.starts_with('0')
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u16>().is_ok()
    });
    if valid {
        Ok(OriginKind::DevLoopback)
    } else {
        Err(NOT_DEV_ADDRESS)
    }
}

fn public_origin_problem(origin: &str) -> Option<&'static str> {
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
            && l.len() <= MAX_LABEL
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
    if RESERVED_TLDS.contains(&labels[labels.len() - 1]) {
        return Some("uses a reserved name that is not on the public internet");
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
        if let Err(reason) = origin_kind(origin) {
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
    check_identity(&name, "name", MAX_NAME)?;

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

    // A UI plugin that only adds visualizers has no page of its own; a sidebar always opens one.
    let entry_optional = tier == Tier::Ui && raw.visualizers.is_some() && raw.sidebar.is_none();
    let entry = match raw.entry {
        None if entry_optional => None,
        entry => Some(require(entry, "entry")?),
    };
    if let Some(entry) = &entry {
        check_path(entry, "entry")?;
        if !has_ext(entry, tier.entry_ext()) {
            return Err(ManifestError::WrongEntryType {
                tier: tier.as_str(),
                expected: tier.entry_ext(),
            });
        }
    }

    let page = match (&raw.page, tier) {
        (None, _) => None,
        (Some(_), Tier::Ui) => {
            return Err(ManifestError::BadPath {
                field: "page",
                reason: "is only for native plugins (a UI plugin's page is its 'entry')",
            })
        }
        (Some(page), Tier::Native) => {
            check_path(page, "page")?;
            if !has_ext(page, ".html") {
                return Err(ManifestError::WrongPageType);
            }
            Some(page.clone())
        }
    };

    let capabilities = validate_capabilities(require(raw.capabilities, "capabilities")?, tier)?;
    // The device name and id travel only in feed events, so the capability alone grants nothing.
    if capabilities.contains(&Capability::AudioDevice)
        && !capabilities.contains(&Capability::AudioEvents)
    {
        return Err(ManifestError::DeviceNeedsEvents);
    }

    let min_plisto = require(raw.min_plisto, "min_plisto")?;
    let min = SemVer::parse(&min_plisto).ok_or_else(|| ManifestError::BadVersion {
        field: "min_plisto",
        value: clip(&min_plisto),
    })?;

    let author = require(raw.author, "author")?;
    check_identity(&author, "author", MAX_AUTHOR)?;

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
    let visualizers = visualizer_decl::validate(raw.visualizers, &capabilities)?;
    let has_nav = sidebar
        .as_ref()
        .is_some_and(|s| s.items.iter().any(|i| i.kind == sidebar_decl::ItemType::Nav));
    if tier == Tier::Native && has_nav && page.is_none() {
        return Err(ManifestError::MissingPage);
    }

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
        page,
        capabilities,
        min_plisto,
        author,
        homepage: raw.homepage,
        native_reason,
        icon: raw.icon,
        modes,
        network,
        sidebar,
        visualizers,
        compat,
    })
}

// Echoed values are clipped so an error line stays one short line.
pub(super) fn clip(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(40).collect()
}

#[cfg(test)]
mod tests;
