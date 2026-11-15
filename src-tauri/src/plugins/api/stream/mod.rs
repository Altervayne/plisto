/*
 * Playback streams: a plugin hands Plisto audio, by URL or as pushed bytes, and Plisto plays it
 * through its own engine as a seat over the parked queue. `hub` holds the one session every end path
 * converges on and `gone` its plugin going away; `methods`, `args` and `ops` answer the `stream.*`
 * calls; `meta` sanitizes the plugin's text and computes what the now-playing surfaces show; `art`
 * turns artwork bytes into covers-cache thumbnails; `watch` follows the engine's signals and the
 * item's limits. The engine, the decode helper, the windows and the stash are reached through a
 * `StreamLink`, so the hub runs in tests against a fake one.
 *
 * Nothing here returns or emits a URL, a header, a path or another plugin's data.
 */

// -- Library Imports --
use serde::Serialize;

// -- Local Imports --
use crate::audio::{SkipDir, StreamEndReason, StreamPhase};

// -- Module Declarations --
mod args;
mod art;
mod gone;
mod hub;
mod link;
mod meta;
mod methods;
mod ops;
mod watch;

#[cfg(test)]
mod test_link;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_art;
#[cfg(test)]
mod tests_ends;
#[cfg(test)]
mod tests_limits;

// -- Re-exports --
pub(crate) use gone::{Gone, Producer};
pub(crate) use hub::StreamHub;
pub(crate) use link::TauriStreamLink;
pub(super) use methods::METHODS;
pub(crate) use watch::spawn_watch;

// ---- End details ----

/// The `unsupported` detail of a decode helper that could not be set up.
pub const DECODER: &str = "decoder";
/// The `unsupported` detail of bytes that do not decode.
pub const FORMAT: &str = "format";

/// What the plugin was told the item is doing. `Reconnecting` is the hub's own: the engine only
/// waits for audio meanwhile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NowState {
    Connecting,
    Buffering,
    Playing,
    Paused,
    Reconnecting,
}

impl From<StreamPhase> for NowState {
    fn from(phase: StreamPhase) -> NowState {
        match phase {
            StreamPhase::Connecting => NowState::Connecting,
            StreamPhase::Buffering => NowState::Buffering,
            StreamPhase::Playing => NowState::Playing,
            StreamPhase::Paused => NowState::Paused,
        }
    }
}

/// The skips the owner takes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Skip {
    pub next: bool,
    pub prev: bool,
}

/// What the seated stream shows, on `player:stream` and from `get_stream_now`. Every text is
/// sanitized. Mirrors `StreamNow` in the frontend's types.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StreamNow {
    pub item: i64,
    pub plugin_id: String,
    pub plugin_name: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub now: Option<String>,
    pub live: bool,
    pub seekable: bool,
    pub state: NowState,
    pub skip: Skip,
    /// Bumps when the artwork changes; 0 means none yet.
    pub art_rev: u64,
    /// Bumps on any change.
    pub rev: u64,
}

/// One item's end, on `player:stream_end`, for the player's toast.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StreamEndNotice {
    pub plugin_id: String,
    pub plugin_name: String,
    pub reason: StreamEndReason,
    pub detail: Option<&'static str>,
}

/// What the owner of the seated stream is told. Mirrors `PluginStreamEvent` in the frontend's types.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    State {
        item: i64,
        state: NowState,
    },
    Skip {
        item: i64,
        direction: SkipDir,
    },
    Room {
        item: i64,
        room: usize,
    },
    Ended {
        item: i64,
        reason: StreamEndReason,
        detail: Option<&'static str>,
    },
}
