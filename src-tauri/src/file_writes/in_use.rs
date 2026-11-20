/*
 * Which tracks the player holds open or is about to open: the seated track, paused or not, and the one
 * that sounds next. The gapless path opens the next file before the current one ends, so a write skips
 * both. While a stream is seated, `track_id` is the stream's own id and the parked library track is
 * the one that comes back when it ends. During a workbench preview `track_id` is None, but the queue
 * still names the track the workbench reopens on close, so that track and its next stay protected.
 */

// -- Local Imports --
use crate::audio::{preload_target, PlayerStatus, QueueMirror};

/// The track ids a write must leave alone right now, the current one first.
// Unused until a command writes a music file in place.
#[allow(dead_code)]
pub fn in_use(status: &PlayerStatus, queue: &QueueMirror) -> Vec<i64> {
    let (current, next) = match (status.track_id, &status.stream) {
        (Some(seated), Some(stream)) => (seated, stream.parked.map(|p| p.track_id)),
        (Some(seated), None) => (seated, next_in_queue(status, queue)),
        (None, _) => match queue.ids.get(status.queue_index) {
            Some(&queued) => (queued, next_in_queue(status, queue)),
            None => return Vec::new(),
        },
    };
    let mut ids = vec![current];
    if let Some(next) = next.filter(|&id| id != current) {
        ids.push(next);
    }
    ids
}

/// The track the engine preloads after the cursor, by the engine's own rule.
fn next_in_queue(status: &PlayerStatus, queue: &QueueMirror) -> Option<i64> {
    preload_target(status.queue_index, queue.ids.len(), status.repeat)
        .and_then(|slot| queue.ids.get(slot).copied())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{ParkedStatus, RepeatMode, StreamPhase, StreamStatus};

    fn status(track: Option<i64>, index: usize, repeat: RepeatMode, playing: bool) -> PlayerStatus {
        PlayerStatus {
            playing,
            track_id: track,
            queue_index: index,
            repeat,
            ..PlayerStatus::default()
        }
    }

    fn queue(ids: &[i64]) -> QueueMirror {
        QueueMirror {
            ids: ids.to_vec(),
            blocks: Vec::new(),
        }
    }

    #[test]
    fn playing_and_paused_hold_the_seated_track_and_the_next() {
        let q = queue(&[10, 20, 30]);
        for playing in [true, false] {
            let s = status(Some(20), 1, RepeatMode::Off, playing);
            assert_eq!(in_use(&s, &q), [20, 30]);
        }
    }

    #[test]
    fn the_end_of_the_queue_holds_only_the_seated_track() {
        let q = queue(&[10, 20, 30]);
        assert_eq!(
            in_use(&status(Some(30), 2, RepeatMode::Off, true), &q),
            [30]
        );
    }

    #[test]
    fn repeat_all_wraps_to_the_first_track() {
        let q = queue(&[10, 20, 30]);
        assert_eq!(
            in_use(&status(Some(30), 2, RepeatMode::All, true), &q),
            [30, 10]
        );
        assert_eq!(
            in_use(&status(Some(10), 0, RepeatMode::All, true), &q),
            [10, 20]
        );
        // A one-track queue wraps to itself.
        assert_eq!(
            in_use(&status(Some(10), 0, RepeatMode::All, true), &queue(&[10])),
            [10]
        );
    }

    #[test]
    fn repeat_one_holds_only_the_seated_track() {
        let q = queue(&[10, 20, 30]);
        assert_eq!(
            in_use(&status(Some(20), 1, RepeatMode::One, true), &q),
            [20]
        );
    }

    #[test]
    fn nothing_seated_and_nothing_queued_holds_nothing() {
        assert!(in_use(&status(None, 0, RepeatMode::Off, false), &queue(&[])).is_empty());
        assert!(in_use(&status(None, 3, RepeatMode::All, false), &queue(&[10, 20])).is_empty());
    }

    #[test]
    fn a_workbench_preview_holds_the_queued_track_and_its_next() {
        let q = queue(&[10, 20, 30]);
        assert_eq!(
            in_use(&status(None, 1, RepeatMode::Off, false), &q),
            [20, 30]
        );
        assert_eq!(
            in_use(&status(None, 2, RepeatMode::All, false), &q),
            [30, 10]
        );
        assert_eq!(in_use(&status(None, 2, RepeatMode::Off, false), &q), [30]);
    }

    #[test]
    fn a_seated_track_with_an_empty_mirror_holds_itself() {
        assert_eq!(
            in_use(&status(Some(10), 0, RepeatMode::All, true), &queue(&[])),
            [10]
        );
    }

    #[test]
    fn a_stream_holds_the_parked_track() {
        let q = queue(&[10, 20, 30]);
        let mut s = status(Some(-5), 0, RepeatMode::Off, true);
        s.stream = Some(StreamStatus {
            live: false,
            seekable: true,
            phase: StreamPhase::Playing,
            parked: Some(ParkedStatus {
                track_id: 10,
                secs: 12.0,
            }),
            parked_cleared: false,
        });
        assert_eq!(in_use(&s, &q), [-5, 10]);

        s.stream.as_mut().unwrap().parked = None;
        assert_eq!(in_use(&s, &q), [-5]);
    }
}
