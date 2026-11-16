/*
 * What the OS card shows and when it changes: the fields of `player:stream` it reads, the diff key,
 * and the pure plan from the last key and the current status and stream to the writes the card needs.
 * No WinRT call is made here, so the whole decision runs under test.
 */

// -- Library Imports --
use windows::Media::MediaPlaybackStatus;

/// The phase of a seated stream, as far as the card tells them apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum StreamPhase {
    Paused,
    #[serde(other)]
    Active,
}

/// Which skips the stream's owner takes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub(super) struct SkipFlags {
    pub next: bool,
    pub prev: bool,
}

/// The fields of `player:stream` the card reads. serde ignores the rest.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub(super) struct StreamCard {
    pub item: i64,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub now: Option<String>,
    pub state: StreamPhase,
    pub skip: SkipFlags,
    pub rev: u64,
}

/// What the card diffs on. `rev` is 0 with no stream seated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CardKey {
    pub track_id: Option<i64>,
    pub playing: bool,
    pub rev: u64,
}

/// What to write to the card for one change.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Plan {
    pub key: CardKey,
    pub status: MediaPlaybackStatus,
    pub metadata: Metadata,
    pub next: bool,
    pub prev: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Metadata {
    Keep,
    Refresh,
    Clear,
}

/// The stream the card shows: the seated one, once the status names its item.
pub(super) fn seated(track_id: Option<i64>, stream: Option<&StreamCard>) -> Option<&StreamCard> {
    stream.filter(|card| track_id == Some(card.item))
}

/// The card's lines for a stream: the track line over the stream's title when it has one, else
/// the title over the artist.
pub(super) fn stream_lines(card: &StreamCard) -> (String, String) {
    match card.now.as_deref().filter(|now| !now.is_empty()) {
        Some(now) => (now.to_string(), card.title.clone()),
        None => (card.title.clone(), card.artist.clone().unwrap_or_default()),
    }
}

/// The OS playback status for a snapshot: Stopped with no track, else Playing or Paused. `playing`
/// already folds in the pause state the engine reports.
fn playback_status(track_id: Option<i64>, playing: bool) -> MediaPlaybackStatus {
    match track_id {
        None => MediaPlaybackStatus::Stopped,
        Some(_) => {
            if playing {
                MediaPlaybackStatus::Playing
            } else {
                MediaPlaybackStatus::Paused
            }
        }
    }
}

/// What changed since `last`, or None when nothing the card shows did. A stream seated is Playing
/// unless paused, whatever phase the engine is in, and its skip flags drive Next and Previous.
/// `ended` is the item of a stream that just ended: while the status still names it, its stash entry
/// is gone and the card keeps what it shows until the status moves on.
pub(super) fn plan(
    last: Option<CardKey>,
    track_id: Option<i64>,
    playing: bool,
    stream: Option<&StreamCard>,
    ended: Option<i64>,
) -> Option<Plan> {
    let card = seated(track_id, stream);
    if card.is_none() && track_id.is_some() && track_id == ended {
        return None;
    }
    let key = CardKey {
        track_id,
        playing,
        rev: card.map_or(0, |card| card.rev),
    };
    if last == Some(key) {
        return None;
    }
    let status = match card {
        Some(card) if card.state == StreamPhase::Paused => MediaPlaybackStatus::Paused,
        Some(_) => MediaPlaybackStatus::Playing,
        None => playback_status(track_id, playing),
    };
    let refreshed = last.map(|last| (last.track_id, last.rev)) != Some((track_id, key.rev));
    let metadata = match (refreshed, track_id) {
        (false, _) => Metadata::Keep,
        (true, Some(_)) => Metadata::Refresh,
        (true, None) => Metadata::Clear,
    };
    let (next, prev) = card.map_or((true, true), |card| (card.skip.next, card.skip.prev));
    Some(Plan {
        key,
        status,
        metadata,
        next,
        prev,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(item: i64, state: StreamPhase, rev: u64) -> StreamCard {
        StreamCard {
            item,
            title: "Station".into(),
            artist: Some("Artist".into()),
            album: None,
            now: None,
            state,
            skip: SkipFlags::default(),
            rev,
        }
    }

    #[test]
    fn stream_rev_refreshes_the_card_without_a_track_change() {
        let first = card(-5, StreamPhase::Active, 1);
        let seated = plan(None, Some(-5), true, Some(&first), None).unwrap();
        assert_eq!(seated.metadata, Metadata::Refresh);

        // Same item, same status, same rev: nothing to write.
        assert_eq!(plan(Some(seated.key), Some(-5), true, Some(&first), None), None);

        let retitled = card(-5, StreamPhase::Active, 2);
        let next = plan(Some(seated.key), Some(-5), true, Some(&retitled), None).unwrap();
        assert_eq!(next.metadata, Metadata::Refresh);
        assert_eq!(next.key.track_id, seated.key.track_id);
    }

    #[test]
    fn skip_flags_drive_the_buttons() {
        let mut stream = card(-5, StreamPhase::Active, 1);
        let none = plan(None, Some(-5), true, Some(&stream), None).unwrap();
        assert_eq!((none.next, none.prev), (false, false));

        stream.skip = SkipFlags { next: true, prev: false };
        stream.rev = 2;
        let next_only = plan(Some(none.key), Some(-5), true, Some(&stream), None).unwrap();
        assert_eq!((next_only.next, next_only.prev), (true, false));

        // A local track keeps both enabled.
        let local = plan(None, Some(7), true, None, None).unwrap();
        assert_eq!((local.next, local.prev), (true, true));
    }

    #[test]
    fn buffering_reports_playing_and_paused_reports_paused() {
        // The engine's `playing` is false while connecting or buffering.
        let active = card(-5, StreamPhase::Active, 1);
        let waiting = plan(None, Some(-5), false, Some(&active), None).unwrap();
        assert_eq!(waiting.status, MediaPlaybackStatus::Playing);

        let paused = card(-5, StreamPhase::Paused, 2);
        let held = plan(None, Some(-5), true, Some(&paused), None).unwrap();
        assert_eq!(held.status, MediaPlaybackStatus::Paused);

        // A stream the status does not name yet does not drive the card.
        let early = plan(None, Some(7), true, Some(&paused), None).unwrap();
        assert_eq!(early.status, MediaPlaybackStatus::Playing);
    }

    #[test]
    fn a_stream_seated_before_the_status_names_it_keeps_the_library_card() {
        let library = plan(None, Some(7), true, None, None).unwrap();
        let waiting = card(-5, StreamPhase::Active, 1);
        assert_eq!(
            plan(Some(library.key), Some(7), true, Some(&waiting), None),
            None
        );

        // The status moves to the item: now the stream's text is written.
        let named = plan(Some(library.key), Some(-5), true, Some(&waiting), None).unwrap();
        assert_eq!(named.metadata, Metadata::Refresh);
    }

    #[test]
    fn the_card_is_held_while_the_status_still_names_an_ended_stream() {
        let live = card(-5, StreamPhase::Active, 3);
        let seated = plan(None, Some(-5), true, Some(&live), None).unwrap();
        assert_eq!(seated.metadata, Metadata::Refresh);

        // The stream is gone and the status still names its item: no write, so no empty text.
        assert_eq!(plan(Some(seated.key), Some(-5), true, None, Some(-5)), None);
        assert_eq!(plan(Some(seated.key), Some(-5), false, None, Some(-5)), None);

        // The status moves to the parked track: the card ends on it.
        let back = plan(Some(seated.key), Some(7), false, None, Some(-5)).unwrap();
        assert_eq!(back.metadata, Metadata::Refresh);
        assert_eq!(back.key.track_id, Some(7));
        assert_eq!((back.next, back.prev), (true, true));
    }

    #[test]
    fn nothing_playing_after_an_ended_stream_clears_the_card() {
        let live = card(-5, StreamPhase::Active, 3);
        let seated = plan(None, Some(-5), true, Some(&live), None).unwrap();
        let cleared = plan(Some(seated.key), None, false, None, Some(-5)).unwrap();
        assert_eq!(cleared.metadata, Metadata::Clear);
        assert_eq!(cleared.status, MediaPlaybackStatus::Stopped);
    }

    #[test]
    fn stream_lines_put_the_track_line_first() {
        let mut stream = card(-5, StreamPhase::Active, 1);
        assert_eq!(stream_lines(&stream), ("Station".into(), "Artist".into()));
        stream.now = Some("Song".into());
        assert_eq!(stream_lines(&stream), ("Song".into(), "Station".into()));
    }
}
