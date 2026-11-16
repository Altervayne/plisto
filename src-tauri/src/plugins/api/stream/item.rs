/*
 * The seated item as the hub holds it: where its bytes come from, its artwork requests, its text and
 * state, and the clocks its limits read.
 */

// -- Library Imports --
use std::sync::Arc;
use std::time::Instant;

// -- Local Imports --
use super::args::Artwork;
use super::feeder::Wire;
use super::gone::Producer;
use super::meta::Meta;
use super::{NowState, Skip, StreamNow};
use crate::adhoc::AdHocCover;
use crate::audio::stream::{PcmQueue, RingWriter, StreamControl};
use crate::audio::{SkipFlags, StreamEndReason};
use crate::plugins::api::net::methods::RESERVED_KEY_PREFIX;

/// Where an item's bytes come from.
pub(super) enum Feed {
    /// Plisto fetches them. The queue's producer half waits here until the first response head
    /// starts decoding.
    Pull { queue: Option<PcmQueue> },
    /// The plugin pushes them. `writer` is gone once the plugin ended its bytes.
    Push {
        writer: Option<RingWriter>,
        wants_room: bool,
    },
}

/// An item's artwork requests. Each request or clear takes a new generation, and only a decode of
/// the current one may land.
#[derive(Default)]
pub(super) struct ArtSlot {
    pub generation: u64,
    // When this item's last decode started: one start per `ART_GAP`.
    pub last: Option<Instant>,
    pub pending: Option<Artwork>,
}

/// The seated item.
pub(super) struct Item {
    pub id: i64,
    pub plugin_id: String,
    pub plugin_name: String,
    pub producer: Producer,
    pub feed: Feed,
    pub control: Arc<StreamControl>,
    pub skip_flags: Arc<SkipFlags>,
    pub skip: Skip,
    pub meta: Meta,
    pub live: bool,
    pub seekable: bool,
    // A finite item's length once its container stated a usable one.
    pub duration: Option<f64>,
    pub state: NowState,
    pub cover: Option<AdHocCover>,
    pub art: ArtSlot,
    pub art_rev: u64,
    pub rev: u64,
    // When the item was accepted, or reconnected before any audio came.
    pub accepted: Instant,
    // Whether any audio was decoded since `accepted`.
    pub heard: bool,
    // Since when the item has waited for audio in connecting or buffering.
    pub waiting_since: Option<Instant>,
    // The fetch is between two connections.
    pub reconnecting: bool,
    // The fetch restarted on a fresh buffer: it shows as reconnecting until the engine plays again.
    pub awaiting_audio: bool,
    // What the plugin's requests go out with; None on a host with no network engine.
    pub wire: Option<Arc<Wire>>,
}

impl Item {
    pub fn is_push(&self) -> bool {
        matches!(self.feed, Feed::Push { .. })
    }

    /// The state the plugin and the windows see: a reconnect shows over the engine's phase unless
    /// the item is paused.
    pub fn shown(&self) -> NowState {
        if (self.reconnecting || self.awaiting_audio) && self.state != NowState::Paused {
            NowState::Reconnecting
        } else {
            self.state
        }
    }

    pub fn snapshot(&self) -> StreamNow {
        StreamNow {
            item: self.id,
            plugin_id: self.plugin_id.clone(),
            plugin_name: self.plugin_name.clone(),
            title: self.meta.title.clone(),
            artist: self.meta.artist.clone(),
            album: self.meta.album.clone(),
            now: self.meta.now.clone(),
            live: self.live,
            seekable: self.seekable,
            duration_secs: self.duration,
            state: self.shown(),
            skip: self.skip,
            art_rev: self.art_rev,
            rev: self.rev,
        }
    }
}

/// A plugin's previous item's end.
pub(super) struct LastEnd {
    pub reason: StreamEndReason,
    pub detail: Option<&'static str>,
    pub at: Instant,
}

/// The abort key the item's own network work runs under: its connections and its artwork fetch.
pub(super) fn net_key(id: i64) -> String {
    format!("{RESERVED_KEY_PREFIX}stream:{id}")
}
