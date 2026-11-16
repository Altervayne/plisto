/*
 * The feeder's requests and what it makes of each response head: the status, the content type, the
 * ICY interval, and on the first head of an epoch what the item is and where its bytes go. The
 * headers Plisto adds itself go beside the plugin's, outside the limits the plugin's were checked
 * against, so they never push a checked request over them.
 */

// -- Library Imports --
use std::sync::Arc;
use std::time::Duration;

use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::{Bytes, Feeder, Next, Progress, STATUS};
use crate::audio::stream::{
    byte_ring, growing_buffer, hint_for_content_type, IcyStripper, StreamInput, Unsupported,
    FINITE_MAX, HEADERS_TIMEOUT_MS, LIVE_RING,
};
use crate::audio::StreamEndReason;
use crate::plugins::api::error::{ApiCode, ApiError};
use crate::plugins::api::net::fetch::{FetchRequest, RedirectMode, StreamHead};
use crate::plugins::api::net::policy::{Method, ResponseHeaders};
use crate::plugins::api::net::{CLOSED, CONNECT, REDIRECT, TLS};
use crate::plugins::api::stream::item::net_key;
use crate::plugins::api::stream::FORMAT;

/// What Plisto asks for unless the plugin set `accept`.
const ACCEPT: &str = "audio/*, application/ogg;q=0.9, */*;q=0.1";

/// What a head says about the body's format: the decoder hint of its content type and whether ICY
/// blocks are interleaved. Every head of an item must say the same.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Shape {
    hint: Option<&'static str>,
    icy: bool,
}

/// What a failed request means for the item.
pub(super) fn failure(error: &ApiError) -> Next {
    match (error.code, error.reason) {
        (ApiCode::Denied, reason) => Next::End(StreamEndReason::Denied, reason),
        (ApiCode::Network, Some(reason @ (TLS | REDIRECT))) => {
            Next::End(StreamEndReason::Network, Some(reason))
        }
        (ApiCode::Network, reason) => {
            Next::Retry(StreamEndReason::Network, reason.or(Some(CLOSED)))
        }
        // No head in time, or a stream slot still held.
        (ApiCode::Timeout | ApiCode::Busy, _) => {
            Next::Retry(StreamEndReason::Network, Some(CONNECT))
        }
        _ => Next::End(StreamEndReason::Network, Some(CLOSED)),
    }
}

/// The log outcome of a head the feeder refused: the status it carried, or Plisto's own stop.
pub(super) fn logged(next: &Next) -> ApiError {
    match next {
        Next::End(StreamEndReason::Network, Some(STATUS))
        | Next::Retry(StreamEndReason::Network, Some(STATUS)) => ApiError::network(STATUS),
        _ => super::stopped(),
    }
}

fn header<'a>(headers: &'a ResponseHeaders, name: &str) -> Option<&'a str> {
    headers
        .headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.trim())
}

/// The start offset of a `content-range: bytes N-M/L` answer.
fn range_start(headers: &ResponseHeaders) -> Option<u64> {
    let range = header(headers, "content-range")?.strip_prefix("bytes ")?;
    range.split('-').next()?.trim().parse().ok()
}

/// What `if-range` may carry: a strong ETag, else the Last-Modified date. A weak ETag cannot
/// validate a range.
fn validator(headers: &ResponseHeaders) -> Option<String> {
    let etag = header(headers, "etag").filter(|tag| !tag.starts_with("W/"));
    etag.or_else(|| header(headers, "last-modified"))
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b == b' ' || b.is_ascii_graphic()))
        .map(str::to_string)
}

impl Feeder {
    /// The next request, and the headers Plisto adds: `accept` and ICY when the plugin did not set
    /// them, and the range a finite body resumes from. Its abort key is the item's own.
    pub(super) fn request(&self, state: &Progress) -> (FetchRequest, Vec<(String, String)>) {
        let resuming = state.bytes.is_some() && !state.live;
        let headers: Vec<(String, String)> = self
            .pull
            .headers
            .iter()
            .filter(|(name, _)| !resuming || (name != "range" && name != "if-range"))
            .cloned()
            .collect();
        let mut own = Vec::new();
        let mut add = |name: &str, value: String| {
            if !headers.iter().any(|(n, _)| n == name) {
                own.push((name.to_string(), value));
            }
        };
        add("accept", ACCEPT.to_string());
        if self.pull.icy {
            add("icy-metadata", "1".to_string());
        }
        if resuming {
            add("range", format!("bytes={}-", state.received));
            if let Some(validator) = &state.validator {
                add("if-range", validator.clone());
            }
        }
        let request = FetchRequest {
            url: self.pull.url.clone(),
            method: Method::Get,
            headers,
            body: Vec::new(),
            redirect: RedirectMode::Follow,
            timeout: Duration::from_millis(HEADERS_TIMEOUT_MS),
            abort_key: Some(net_key(self.id)),
            user_agent: self.wire.user_agent.clone(),
        };
        (request, own)
    }

    /// The status, the content type and the ICY interval of a head: the stripper for this body and
    /// the head's shape, which must match the first head's.
    pub(super) fn check_head(
        &self,
        head: &StreamHead,
        state: &Progress,
    ) -> Result<(Option<IcyStripper>, Shape), Next> {
        let resuming = state.bytes.is_some() && !state.live;
        match head.status {
            206 if resuming => {
                if range_start(&head.headers) != Some(state.received) {
                    return Err(Next::End(StreamEndReason::Network, Some(CLOSED)));
                }
            }
            // A full body again would repeat what was already heard.
            _ if resuming => return Err(Next::End(StreamEndReason::Network, Some(CLOSED))),
            200 => {}
            500..=599 => return Err(Next::Retry(StreamEndReason::Network, Some(STATUS))),
            _ => return Err(Next::End(StreamEndReason::Network, Some(STATUS))),
        }
        let hint = match hint_for_content_type(header(&head.headers, "content-type")) {
            Ok(hint) => hint,
            Err(why) => {
                let detail = match why {
                    Unsupported::Playlist => "playlist",
                    _ => "content_type",
                };
                return Err(Next::End(StreamEndReason::Unsupported, Some(detail)));
            }
        };
        let icy = match header(&head.headers, "icy-metaint") {
            None => None,
            Some(raw) => match raw.parse().ok().and_then(IcyStripper::new) {
                Some(stripper) => Some(stripper),
                // Metadata that cannot be stripped would reach the decoder as audio.
                None => return Err(Next::End(StreamEndReason::Unsupported, Some(FORMAT))),
            },
        };
        let shape = Shape {
            hint,
            icy: icy.is_some(),
        };
        if state.shape.is_some_and(|first| first != shape) {
            return Err(Next::End(StreamEndReason::Unsupported, Some(FORMAT)));
        }
        Ok((icy, shape))
    }

    /// Builds the epoch's byte buffer and starts its decoding. On the item's first head it also
    /// decides what the item is.
    pub(super) fn first_head(
        &self,
        headers: &ResponseHeaders,
        state: &mut Progress,
        shape: Shape,
    ) -> Result<(), Next> {
        let length = header(headers, "content-length").and_then(|v| v.parse::<u64>().ok());
        let icy = headers.headers.iter().any(|(n, _)| n.starts_with("icy-"));
        if state.shape.is_none() {
            state.live = self.pull.live.unwrap_or(length.is_none() || icy);
            state.length = if state.live { None } else { length };
            state.validator = validator(headers);
            state.ranges = !state.live
                && !icy
                && state.validator.is_some()
                && header(headers, "accept-ranges").is_some_and(|v| v == "bytes");
        }
        let live = state.live;
        let seekable = !live && state.length.is_some_and(|len| len <= FINITE_MAX);
        let control = Arc::clone(&self.control);
        let (bytes, source): (Bytes, Box<dyn MediaSource>) = match state.length.filter(|_| seekable)
        {
            Some(len) => {
                let (writer, buffer) = growing_buffer(len, control);
                (Bytes::Body(writer), Box::new(buffer))
            }
            None => {
                let (writer, ring) = byte_ring(LIVE_RING, control);
                (Bytes::Ring(writer), Box::new(ring))
            }
        };
        let input = StreamInput::Media {
            source,
            hint: shape.hint,
        };
        let started = self
            .hub()
            .is_some_and(|hub| hub.pull_head(self.id, live, seekable, input));
        if !started {
            return Err(Next::Done);
        }
        state.shape = Some(shape);
        state.bytes = Some(bytes);
        Ok(())
    }
}
