/*
 * What an owner does to its own item after the start: transport, pushed bytes, metadata, and the
 * reads of the session. Every operation names the item, and an item that is not the caller's current
 * one is `not_found`, so a plugin never learns or touches another plugin's item.
 */

// -- Library Imports --
use std::time::Instant;

use serde_json::{json, Value};

// -- Local Imports --
use super::args::{Artwork, Update};
use super::hub::{publish, Feed, Item, Session, StreamHub, Teller};
use super::watch::LAST_END_HOLD;
use crate::audio::stream::WriteError;
use crate::audio::{PlayerCmd, StreamEndReason};
use crate::plugins::api::error::ApiError;

/// Plugin `id`'s seated item when it is `item`.
fn owned<'a>(session: &'a mut Session, id: &str, item: i64) -> Result<&'a mut Item, ApiError> {
    session
        .item
        .as_mut()
        .filter(|seated| seated.id == item && seated.plugin_id == id)
        .ok_or_else(ApiError::not_found)
}

impl StreamHub {
    /// Whether the caller's item is live.
    pub(super) fn is_live(&self, id: &str, item: i64) -> Result<bool, ApiError> {
        owned(&mut self.lock(), id, item).map(|item| item.live)
    }

    /// The owner's own pause or resume.
    pub(super) fn pause(&self, id: &str, item: i64, pause: bool) -> Result<(), ApiError> {
        let link = self.link().ok_or_else(ApiError::unavailable)?;
        let mut session = self.lock();
        owned(&mut session, id, item)?;
        if link.send(PlayerCmd::StreamPause { id: item, pause }) {
            Ok(())
        } else {
            Err(ApiError::unavailable())
        }
    }

    /// The owner's stop: the item ends `stopped`.
    pub(super) fn stop(&self, id: &str, item: i64) -> Result<(), ApiError> {
        let link = self.link().ok_or_else(ApiError::unavailable)?;
        let mut session = self.lock();
        owned(&mut session, id, item)?;
        let reason = StreamEndReason::Stopped;
        self.end_current(
            &mut session,
            &*link,
            item,
            reason,
            None,
            Teller::Hub,
            Instant::now(),
        );
        Ok(())
    }

    /// Writes pushed bytes without waiting. Answers the audio queued and the byte room left; `busy`
    /// when they do not fit, and a `room` event follows once half the ring is free.
    pub(super) fn push(&self, id: &str, item: i64, bytes: &[u8]) -> Result<(u64, usize), ApiError> {
        let mut session = self.lock();
        let seated = owned(&mut session, id, item)?;
        let buffered = seated.control.buffered_ms();
        let Feed::Push { writer, wants_room } = &mut seated.feed else {
            return Err(ApiError::invalid_args("The item is not a push item."));
        };
        let Some(writer) = writer else {
            return Err(ApiError::invalid_args("The item's bytes have ended."));
        };
        match writer.try_write(bytes) {
            Ok(room) => Ok((buffered, room)),
            Err(WriteError::Full { .. }) => {
                *wants_room = true;
                Err(ApiError::busy())
            }
            // The item is ending.
            Err(WriteError::TooLarge | WriteError::Closed) => Err(ApiError::not_found()),
        }
    }

    /// The end of the pushed bytes: what is left plays out, then the item ends `finished`.
    pub(super) fn end_push(&self, id: &str, item: i64) -> Result<(), ApiError> {
        let mut session = self.lock();
        let seated = owned(&mut session, id, item)?;
        let Feed::Push { writer, .. } = &mut seated.feed else {
            return Err(ApiError::invalid_args("The item is not a push item."));
        };
        if let Some(writer) = writer.take() {
            writer.finish();
        }
        Ok(())
    }

    /// Applies a checked `stream.update`: one stash rewrite and one `player:stream` per call.
    pub(super) fn update(&self, id: &str, item: i64, update: Update) -> Result<(), ApiError> {
        let link = self.link().ok_or_else(ApiError::unavailable)?;
        let mut session = self.lock();
        let seated = owned(&mut session, id, item)?;
        if let Some(title) = update.title {
            seated.meta.title = title;
        }
        if let Some(artist) = update.artist {
            seated.meta.artist = artist;
        }
        if let Some(album) = update.album {
            seated.meta.album = album;
        }
        if let Some(now) = update.now {
            seated.meta.now = now;
        }
        if let Some(skip) = update.skip {
            seated.skip = skip;
            seated.skip_flags.set(skip.next, skip.prev);
        }
        let mut wanted = None;
        match update.artwork {
            // A decode still running for an earlier request lands on an older generation.
            Some(None) => {
                seated.art.generation += 1;
                seated.art.pending = None;
                if seated.cover.take().is_some() {
                    seated.art_rev += 1;
                }
            }
            Some(Some(Artwork::Bytes(bytes))) => wanted = Some(bytes),
            Some(Some(Artwork::Url)) | None => {}
        }
        seated.rev += 1;
        publish(&*link, seated);
        if let Some(bytes) = wanted {
            self.want_art(&mut session, bytes, &link, Instant::now());
        }
        Ok(())
    }

    /// `stream.state` for plugin `id`.
    pub(super) fn state(&self, id: &str, now: Instant) -> Value {
        let link = self.link();
        let session = self.lock();
        let last_end = session
            .last_end
            .get(id)
            .filter(|end| now.saturating_duration_since(end.at) < LAST_END_HOLD)
            .map(|end| json!({ "reason": end.reason, "detail": end.detail }));
        match session.item.as_ref().filter(|item| item.plugin_id == id) {
            Some(item) => json!({
                "item": item.id,
                "state": item.state,
                "live": item.live,
                "seekable": item.seekable,
                "position_secs": link.and_then(|link| link.position(item.id)),
                "duration_secs": Value::Null,
                "buffered_ms": item.control.buffered_ms(),
                "last_end": last_end,
            }),
            None => json!({
                "item": Value::Null,
                "state": Value::Null,
                "live": Value::Null,
                "seekable": Value::Null,
                "position_secs": Value::Null,
                "duration_secs": Value::Null,
                "buffered_ms": Value::Null,
                "last_end": last_end,
            }),
        }
    }

    /// The seated stream as another plugin's `playback.state` reads it: its cleaned title and
    /// artist, whether it is live, and whether caller `id` owns it.
    pub(crate) fn describe(&self, id: &str) -> Value {
        match self.lock().item.as_ref() {
            Some(item) => json!({
                "title": item.meta.title,
                "artist": item.meta.artist,
                "live": item.live,
                "mine": item.plugin_id == id,
            }),
            None => Value::Null,
        }
    }
}
