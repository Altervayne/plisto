/*
 * Everything the stream hub reaches outside itself: the engine thread, the decode helper, the
 * ad-hoc stash, the windows and the covers cache. In the app all of it goes through the managed
 * `AppState`, read at each call, so the hub never holds a clone of the engine's command channel.
 * Every method returns at once: none waits on the engine, a helper or a window. The one that writes
 * files, `cache_art`, is called only from the artwork thread, never under the hub lock; the hub
 * deletes the few small files of an artwork it lets go of in `covers` itself.
 */

// -- Library Imports --
use std::io;
use std::path::PathBuf;

use image::DynamicImage;
use tauri::{AppHandle, Emitter, Manager};

// -- Local Imports --
use super::{StreamEndNotice, StreamEvent, StreamNow};
use crate::adhoc::AdHocTrack;
use crate::audio::stream::{
    start_decode, DecodeEnd, DecodeMode, HelperKind, PcmQueue, StreamInput,
};
use crate::audio::PlayerCmd;
use crate::commands::covers::{DETAIL_EDGE, THUMB_EDGE};
use crate::covers::ensure_thumbs_from;
use crate::plugins::api::host_event::{HostEvent, StreamHostEvent};
use crate::plugins::api::tauri_host::TauriHost;
use crate::plugins::api::HostContext;
use crate::state::AppState;

pub const EVENT_NOW: &str = "player:stream";
pub const EVENT_END: &str = "player:stream_end";

/// Called once with how the decoding ended.
pub type OnEnd = Box<dyn FnOnce(DecodeEnd) + Send>;

pub trait StreamLink: Send + Sync {
    /// Sends `cmd` to the engine thread. False when it is gone.
    fn send(&self, cmd: PlayerCmd) -> bool;
    /// Starts decoding `input` into `queue`: container bytes in a decode helper, `pcm_s16le` in
    /// process.
    fn decode(&self, input: StreamInput, queue: PcmQueue, on_end: OnEnd) -> io::Result<()>;
    /// Writes the stash entry of item `id`, or removes it.
    fn stash(&self, id: i64, track: Option<AdHocTrack>);
    /// `player:stream`, to every window.
    fn now(&self, now: Option<&StreamNow>);
    /// `player:stream_end`, to every window.
    fn ended(&self, notice: &StreamEndNotice);
    /// A stream event for plugin `id`.
    fn owner(&self, id: &str, event: StreamEvent);
    /// Writes both cover thumbnail sizes of a decoded image under `key`. False when the cache cannot
    /// be written.
    fn cache_art(&self, key: &str, image: &DynamicImage) -> bool;
    /// The covers folder stream artwork is written to; None before the app is set up, and on a link
    /// that writes no artwork.
    fn covers(&self) -> Option<PathBuf> {
        None
    }
    /// Where the engine stands in item `id`: the listened time or the play head. None when the
    /// engine reports another track.
    fn position(&self, id: i64) -> Option<f64>;
}

/// The link of the running app.
pub struct TauriStreamLink {
    app: AppHandle,
}

impl TauriStreamLink {
    pub fn new(app: AppHandle) -> TauriStreamLink {
        TauriStreamLink { app }
    }

    fn state(&self) -> Option<tauri::State<'_, AppState>> {
        self.app.try_state::<AppState>()
    }
}

impl StreamLink for TauriStreamLink {
    fn send(&self, cmd: PlayerCmd) -> bool {
        self.state()
            .is_some_and(|state| state.player.send(cmd).is_ok())
    }

    fn decode(&self, input: StreamInput, queue: PcmQueue, on_end: OnEnd) -> io::Result<()> {
        let mode = DecodeMode::Isolated(HelperKind::Stream);
        start_decode(input, queue, on_end, mode).map(drop)
    }

    fn stash(&self, id: i64, track: Option<AdHocTrack>) {
        let Some(state) = self.state() else {
            return;
        };
        let Ok(mut stash) = state.ad_hoc.lock() else {
            return;
        };
        match track {
            Some(track) => stash.insert(id, track),
            None => stash.remove(&id),
        };
    }

    fn now(&self, now: Option<&StreamNow>) {
        let _ = self.app.emit(EVENT_NOW, now);
    }

    fn ended(&self, notice: &StreamEndNotice) {
        let _ = self.app.emit(EVENT_END, notice);
    }

    fn owner(&self, id: &str, event: StreamEvent) {
        let event = StreamHostEvent {
            id: id.to_string(),
            event,
        };
        TauriHost::new(self.app.clone()).emit(HostEvent::Stream(event));
    }

    fn cache_art(&self, key: &str, image: &DynamicImage) -> bool {
        let Some(state) = self.state() else {
            return false;
        };
        let (dir, guard) = (&state.covers_dir, &state.covers_in_flight);
        ensure_thumbs_from(dir, key, image, &[THUMB_EDGE, DETAIL_EDGE], guard).is_ok()
    }

    fn covers(&self) -> Option<PathBuf> {
        self.state().map(|state| state.covers_dir.clone())
    }

    fn position(&self, id: i64) -> Option<f64> {
        let state = self.state()?;
        let status = state.player_status.lock().ok()?;
        (status.track_id == Some(id)).then_some(status.position_secs)
    }
}
