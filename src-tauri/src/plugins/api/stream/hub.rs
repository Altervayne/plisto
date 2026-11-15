/*
 * The stream hub: the one session of the one seated stream, app-wide. A play is accepted under the
 * session lock together with the check that its plugin still serves, and `forget` takes the same lock
 * before it reads the serving set, so a play racing a disable is either refused or seated and then
 * ended; it never survives the plugin.
 *
 * Every end goes through `end_current`, under the lock: the first caller takes the item and the rest
 * find nothing, so an end reported by the engine, by the decoder, by a limit and by the hub itself
 * lands once. Ending cancels the item's control, which ends its decode helper and its byte buffer,
 * and never waits for either.
 *
 * Everything the hub tells the engine and the windows goes out while the lock is held, so the order
 * of the events is the order of the decisions. The link never calls back into the hub.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::Instant;

use crossbeam_channel::{Receiver, Sender};

// -- Local Imports --
use super::args::{Artwork, Play, Source};
use super::gone::Producer;
use super::link::{OnEnd, StreamLink};
use super::meta::{display_pair, Meta};
use super::{NowState, Skip, StreamEndNotice, StreamEvent, StreamNow, DECODER};
use crate::adhoc::{next_ad_hoc_id, AdHocCover, AdHocTrack};
use crate::audio::stream::{
    byte_ring, hint_for_push, pcm_queue, PcmQueue, PushFormat, RingWriter, StreamControl,
    StreamInput, LIVE_RING,
};
use crate::audio::{AudioSpec, PlayerCmd, SkipFlags, StreamEndReason, StreamItem, StreamSignal};
use crate::plugins::api::error::ApiError;
use crate::plugins::state::EnabledSet;

/// Where an item's bytes come from.
pub(super) enum Feed {
    /// Plisto fetches them. The queue's producer half waits here for the fetch to start decoding.
    Pull { _queue: PcmQueue },
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
    pub pending: Option<Vec<u8>>,
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
    pub state: NowState,
    pub cover: Option<AdHocCover>,
    pub art: ArtSlot,
    pub art_rev: u64,
    pub rev: u64,
    pub accepted: Instant,
    // Whether any audio was decoded since `accepted`.
    pub heard: bool,
    // Since when the item has waited for audio in connecting or buffering.
    pub waiting_since: Option<Instant>,
}

impl Item {
    pub fn is_push(&self) -> bool {
        matches!(self.feed, Feed::Push { .. })
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
            state: self.state,
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

#[derive(Default)]
pub(super) struct Session {
    pub item: Option<Item>,
    // Plugins with a play between its first check and its seat.
    accepting: HashSet<String>,
    pub last_end: HashMap<String, LastEnd>,
    // The app is leaving: nothing is accepted any more.
    pub closed: bool,
    // An app update is installing: nothing is accepted until it is released.
    pub held: bool,
    // An artwork decode is running, app-wide.
    pub art_busy: bool,
}

/// Who already knows of an end, so it is not sent back to them.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Teller {
    /// The hub decided: the engine is told.
    Hub,
    /// The engine reported it.
    Engine,
    /// A newer play replaces the item: its `StreamStart` drops the old seat.
    Replacing,
}

pub(super) struct Shared {
    session: Mutex<Session>,
    link: RwLock<Option<Arc<dyn StreamLink>>>,
    serving: RwLock<Option<EnabledSet>>,
    pub signals: (Sender<StreamSignal>, Receiver<StreamSignal>),
}

/// Cheap to clone; every clone shares the same session.
#[derive(Clone)]
pub struct StreamHub(pub(super) Arc<Shared>);

impl Default for StreamHub {
    fn default() -> StreamHub {
        StreamHub(Arc::new(Shared {
            session: Mutex::new(Session::default()),
            link: RwLock::new(None),
            serving: RwLock::new(None),
            signals: crossbeam_channel::unbounded(),
        }))
    }
}

/// A play of plugin `id` on its way to its seat. `first` is false when another play of the plugin
/// was already on its way: that one marks the plugin, and this one is refused `busy`.
pub(super) struct Accepting<'a> {
    hub: &'a StreamHub,
    id: String,
    first: bool,
}

impl Drop for Accepting<'_> {
    fn drop(&mut self) {
        if self.first {
            self.hub.lock().accepting.remove(&self.id);
        }
    }
}

/// The plugin a play comes from.
pub(super) struct Owner {
    pub id: String,
    pub name: String,
    pub producer: Producer,
}

impl StreamHub {
    pub(super) fn lock(&self) -> MutexGuard<'_, Session> {
        self.0
            .session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn link(&self) -> Option<Arc<dyn StreamLink>> {
        self.0
            .link
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Connects the hub to the engine and the windows. Until then every play is `unavailable`.
    pub fn attach(&self, link: Arc<dyn StreamLink>) {
        *self.0.link.write().unwrap_or_else(PoisonError::into_inner) = Some(link);
    }

    /// The serving set `forget` reads.
    pub fn watch_serving(&self, enabled: EnabledSet) {
        *self
            .0
            .serving
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(enabled);
    }

    pub(super) fn serves(&self, id: &str) -> bool {
        self.0
            .serving
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|set| set.contains(id))
    }

    /// Marks a checked play of `id` as on its way to its seat.
    pub(super) fn begin(&self, id: &str) -> Accepting<'_> {
        Accepting {
            hub: self,
            id: id.to_string(),
            first: self.lock().accepting.insert(id.to_string()),
        }
    }

    /// Seats a checked play over whatever plays, and returns its item. `unavailable` when the plugin
    /// no longer serves, the hub is closed or held, or the engine is gone; then `busy` while the
    /// plugin's previous play is still on its way. A refused play changes nothing.
    pub(super) fn accept(
        &self,
        owner: Owner,
        play: Play,
        accepting: &Accepting<'_>,
        enabled: &EnabledSet,
        now: Instant,
    ) -> Result<i64, ApiError> {
        let link = self.link().ok_or_else(ApiError::unavailable)?;
        let mut session = self.lock();
        if session.closed || session.held || enabled.serving(&owner.id).is_none() {
            return Err(ApiError::unavailable());
        }
        if !accepting.first {
            return Err(ApiError::busy());
        }
        let id = next_ad_hoc_id();
        let control = Arc::new(StreamControl::new());
        let (queue, reader) = pcm_queue(Arc::clone(&control));
        let skip_flags = Arc::new(SkipFlags::new(play.skip.next, play.skip.prev));
        let (feed, decode) = match play.source {
            Source::Pull => (Feed::Pull { _queue: queue }, None),
            Source::Push(format) => {
                let (writer, ring) = byte_ring(LIVE_RING, Arc::clone(&control));
                let input = match format {
                    PushFormat::PcmS16le { rate, channels } => StreamInput::PcmS16le {
                        source: Box::new(ring),
                        spec: AudioSpec {
                            sample_rate: rate,
                            channels,
                        },
                    },
                    format => StreamInput::Media {
                        source: Box::new(ring),
                        hint: hint_for_push(format),
                    },
                };
                let feed = Feed::Push {
                    writer: Some(writer),
                    wants_room: false,
                };
                (feed, Some((input, queue)))
            }
        };
        let seat = StreamItem {
            id,
            live: play.live,
            seekable: false,
            duration_secs: None,
            pcm: reader,
            control: Arc::clone(&control),
            skip: Arc::clone(&skip_flags),
            signals: self.0.signals.0.clone(),
        };
        if let Some(old) = session.item.take() {
            let reason = StreamEndReason::Replaced;
            self.end_item(
                &mut session,
                &*link,
                old,
                reason,
                None,
                Teller::Replacing,
                now,
            );
        }
        if !link.send(PlayerCmd::StreamStart(seat)) {
            control.cancel();
            // A replaced item left its snapshot showing.
            link.now(None);
            return Err(ApiError::unavailable());
        }
        let item = Item {
            id,
            plugin_id: owner.id,
            plugin_name: owner.name,
            producer: owner.producer,
            feed,
            control,
            skip_flags,
            skip: play.skip,
            meta: play.meta,
            live: play.live,
            seekable: false,
            state: NowState::Connecting,
            cover: None,
            art: ArtSlot::default(),
            art_rev: 0,
            rev: 1,
            accepted: now,
            heard: false,
            waiting_since: None,
        };
        publish(&*link, &item);
        session.item = Some(item);
        if let Some(Artwork::Bytes(bytes)) = play.artwork {
            self.want_art(&mut session, bytes, &link, now);
        }
        if let Some((input, queue)) = decode {
            if link.decode(input, queue, self.on_end(id)).is_err() {
                eprintln!("plugins: a stream decode thread could not start");
                let reason = StreamEndReason::Unsupported;
                self.end_current(
                    &mut session,
                    &*link,
                    id,
                    reason,
                    Some(DECODER),
                    Teller::Hub,
                    now,
                );
            }
        }
        Ok(id)
    }

    /// The decoder's end, reported to the hub without keeping it alive.
    fn on_end(&self, id: i64) -> OnEnd {
        let hub = Arc::downgrade(&self.0);
        Box::new(move |end| {
            if let Some(shared) = hub.upgrade() {
                StreamHub(shared).decode_ended(id, end, Instant::now());
            }
        })
    }

    /// Ends item `id` when it is still seated.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn end_current(
        &self,
        session: &mut Session,
        link: &dyn StreamLink,
        id: i64,
        reason: StreamEndReason,
        detail: Option<&'static str>,
        teller: Teller,
        now: Instant,
    ) {
        if session.item.as_ref().is_some_and(|item| item.id == id) {
            if let Some(item) = session.item.take() {
                self.end_item(session, link, item, reason, detail, teller, now);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn end_item(
        &self,
        session: &mut Session,
        link: &dyn StreamLink,
        item: Item,
        reason: StreamEndReason,
        detail: Option<&'static str>,
        teller: Teller,
        now: Instant,
    ) {
        item.control.cancel();
        link.stash(item.id, None);
        if teller == Teller::Hub {
            link.send(PlayerCmd::StreamEnd {
                id: item.id,
                reason,
            });
        }
        if teller != Teller::Replacing {
            link.now(None);
        }
        link.ended(&StreamEndNotice {
            plugin_id: item.plugin_id.clone(),
            plugin_name: item.plugin_name.clone(),
            reason,
            detail,
        });
        // A plugin that is gone is not told.
        if reason != StreamEndReason::PluginGone {
            let ended = StreamEvent::Ended {
                item: item.id,
                reason,
                detail,
            };
            link.owner(&item.plugin_id, ended);
        }
        let last = LastEnd {
            reason,
            detail,
            at: now,
        };
        session.last_end.insert(item.plugin_id, last);
    }

    /// Ends item `id` for `reason`, telling the engine.
    pub(super) fn finish(&self, id: i64, reason: StreamEndReason, detail: Option<&'static str>) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        self.end_current(
            &mut session,
            &*link,
            id,
            reason,
            detail,
            Teller::Hub,
            Instant::now(),
        );
    }

    /// What the seated stream shows; None when nothing is seated.
    pub fn now(&self) -> Option<StreamNow> {
        self.lock().item.as_ref().map(Item::snapshot)
    }
}

/// Writes the item's stash entry and its `player:stream` snapshot.
pub(super) fn publish(link: &dyn StreamLink, item: &Item) {
    let (title, artist) = display_pair(&item.meta);
    let track = AdHocTrack {
        title,
        artist,
        cover: item.cover.clone(),
    };
    link.stash(item.id, Some(track));
    link.now(Some(&item.snapshot()));
}
