/*
 * The pure queue motion and shuffle helpers behind the engine: cursor moves, queue edits that keep the
 * pristine order in step, and a seeded shuffle. No sink, no device, no clock, so every rule tests on
 * plain values.
 */

// -- Local Imports --
use super::{QueueTrack, RepeatMode};

// ---- Pure queue motion ----

/// The next index after `index`, or None when the queue ends and repeat does not loop it. Every
/// cursor move in the engine goes through this - the engine never hand-rolls an index.
pub(crate) fn advance_index(index: usize, len: usize, repeat: RepeatMode) -> Option<usize> {
    if len == 0 {
        return None;
    }
    if index >= len - 1 {
        match repeat {
            RepeatMode::All => Some(0),
            _ => None,
        }
    } else {
        Some(index + 1)
    }
}

/// Clamps a target index into the queue, so an over-range jump lands on the last track. An empty
/// queue clamps to 0, which play_at reads as a stop.
pub(crate) fn clamp_index(index: usize, len: usize) -> usize {
    index.min(len.saturating_sub(1))
}

/// The previous index, saturating at the first track. None only when the queue is empty.
pub(crate) fn prev_index(index: usize, len: usize) -> Option<usize> {
    if len == 0 {
        None
    } else {
        Some(index.saturating_sub(1))
    }
}

/// Appends `tracks` to the play queue and the pristine order in lockstep, so a later shuffle-off
/// restore keeps them and they stay last in up-next either way. Returns the index of the first
/// appended track, the slot a cold-start engine begins playing from.
pub(crate) fn enqueue_tracks(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    tracks: Vec<QueueTrack>,
) -> usize {
    let first_new = queue.len();
    queue.extend(tracks.iter().cloned());
    original_order.extend(tracks);
    first_new
}

/// Inserts `tracks` right after the playing track, in the caller's order. Unshuffled, the pristine
/// order is rebaselined to the new queue. Shuffled, the tracks also go right after the playing
/// track's pristine slot (or last when it has none), so turning shuffle off keeps them next. With
/// no playing track (`cur_track_id` None) they append like a cold-start enqueue. Returns the queue
/// index of the first inserted track.
pub(crate) fn insert_after_current(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    shuffle: bool,
    index: usize,
    cur_track_id: Option<i64>,
    tracks: Vec<QueueTrack>,
) -> usize {
    let at = match cur_track_id {
        Some(_) if !queue.is_empty() => (index + 1).min(queue.len()),
        _ => queue.len(),
    };
    queue.splice(at..at, tracks.iter().cloned());
    if !shuffle {
        *original_order = queue.clone();
    } else {
        let pristine_at = cur_track_id
            .and_then(|id| original_order.iter().position(|t| t.id == id))
            .map_or(original_order.len(), |pos| pos + 1);
        original_order.splice(pristine_at..pristine_at, tracks);
    }
    at
}

/// Moves the queue item at `from` to `to`, keeping the pristine order in step: an unshuffled reorder
/// rebaselines the pristine order to the new order, a shuffled reorder leaves it pristine. Returns
/// false without changing anything when the queue is empty, `from` is out of range, or `from == to`.
/// Never clamps `from`: a stale over-range index would move the wrong track.
pub(crate) fn move_queue_item(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    shuffle: bool,
    from: usize,
    to: usize,
) -> bool {
    let len = queue.len();
    if len == 0 || from >= len || from == to {
        return false;
    }
    let item = queue.remove(from);
    let dest = to.min(queue.len());
    queue.insert(dest, item);
    if !shuffle {
        *original_order = queue.clone();
    }
    true
}

/// Removes the queue item at `index` and keeps the pristine order in step: an unshuffled remove
/// rebaselines the pristine order to the shortened queue, a shuffled remove drops the first pristine
/// entry with the removed id. Returns the removed track's id, or None when `index` is out of range.
pub(crate) fn remove_queue_item(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    shuffle: bool,
    index: usize,
) -> Option<i64> {
    if index >= queue.len() {
        return None;
    }
    let removed_id = queue[index].id;
    queue.remove(index);
    if !shuffle {
        *original_order = queue.clone();
    } else if let Some(pos) = original_order.iter().position(|t| t.id == removed_id) {
        original_order.remove(pos);
    }
    Some(removed_id)
}

/// The play-cursor position after a queue mutation: the slot of the currently playing track by id,
/// or a clamped fallback from `current` when nothing plays or the id is gone. Keeps advance/prev/
/// on_track_end stepping from the right slot without touching the sink.
pub(crate) fn reseat_index(
    queue: &[QueueTrack],
    cur_track_id: Option<i64>,
    current: usize,
) -> usize {
    let fallback = current.min(queue.len().saturating_sub(1));
    cur_track_id
        .and_then(|id| queue.iter().position(|t| t.id == id))
        .unwrap_or(fallback)
}

/// What to do when a track finishes on its own.
pub(crate) enum EndAction {
    Replay,
    Advance(usize),
    Stop,
}

/// Resolves a natural track-end into an action: repeat-one replays in place, otherwise it advances
/// (looping the queue under repeat-all) or stops at the end.
pub(crate) fn on_track_end(index: usize, len: usize, repeat: RepeatMode) -> EndAction {
    if let RepeatMode::One = repeat {
        return EndAction::Replay;
    }
    match advance_index(index, len, repeat) {
        Some(i) => EndAction::Advance(i),
        None => EndAction::Stop,
    }
}

/// The slot that plays when the track at `index` ends on its own, or None when playback stops there.
/// Built on `on_track_end`, so a preloaded next track and the cold end always pick the same slot.
pub(crate) fn preload_target(index: usize, len: usize, repeat: RepeatMode) -> Option<usize> {
    let slot = match on_track_end(index, len, repeat) {
        EndAction::Replay => index,
        EndAction::Advance(i) => i,
        EndAction::Stop => return None,
    };
    (slot < len).then_some(slot)
}

/// Where a preload holding track `id` sits after the queue, cursor or repeat mode changed: the target
/// slot when it still holds `id`, else None and the preload is stale.
pub(crate) fn pending_slot(
    queue: &[QueueTrack],
    index: usize,
    repeat: RepeatMode,
    id: i64,
) -> Option<usize> {
    preload_target(index, queue.len(), repeat).filter(|&slot| queue[slot].id == id)
}

// ---- Shuffle ----

/// A tiny seeded xorshift64 PRNG, so shuffle needs no crate. Deterministic from its seed: the same
/// seed and call sequence yield the same numbers. The engine owns one instance seeded at spawn.
pub(crate) struct Xorshift {
    state: u64,
}

impl Xorshift {
    /// Seeds the generator. Zero would lock xorshift at zero forever, so it maps to a fixed non-zero
    /// constant instead.
    pub(super) fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0x9e37_79b9_7f4a_7c15 } else { seed },
        }
    }

    /// The next 64-bit value, advancing the state.
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    /// A value in [0, bound), for a bound of at least one. The modulo's bias is immaterial at queue
    /// lengths.
    fn below(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }
}

/// A permutation of `0..len` with `pin` fixed at position 0 and the rest Fisher-Yates shuffled by
/// `rng`. Pure: the same len, pin and rng state always yield the same order. `pin` is clamped into
/// range; len 0 yields an empty order and len 1 the single index. Pinning the current track to the
/// front is what lets a live shuffle keep it playing without touching the sink.
pub(crate) fn shuffle_order(len: usize, pin: usize, rng: &mut Xorshift) -> Vec<usize> {
    if len == 0 {
        return Vec::new();
    }
    let pin = pin.min(len - 1);
    let mut rest: Vec<usize> = (0..len).filter(|&i| i != pin).collect();
    for i in (1..rest.len()).rev() {
        let j = rng.below(i + 1);
        rest.swap(i, j);
    }
    let mut order = Vec::with_capacity(len);
    order.push(pin);
    order.extend(rest);
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ---- Pure queue motion ----

    #[test]
    fn advance_stops_at_end_when_off() {
        assert_eq!(advance_index(2, 3, RepeatMode::Off), None);
    }

    #[test]
    fn advance_loops_at_end_when_all() {
        assert_eq!(advance_index(2, 3, RepeatMode::All), Some(0));
    }

    #[test]
    fn advance_stops_at_end_when_one() {
        // Repeat-one never advances the queue; on_track_end handles the replay instead.
        assert_eq!(advance_index(2, 3, RepeatMode::One), None);
    }

    #[test]
    fn advance_steps_forward_in_the_middle() {
        assert_eq!(advance_index(0, 3, RepeatMode::Off), Some(1));
    }

    #[test]
    fn advance_on_empty_queue_is_none() {
        assert_eq!(advance_index(0, 0, RepeatMode::All), None);
    }

    #[test]
    fn prev_saturates_at_the_first_track() {
        assert_eq!(prev_index(0, 3), Some(0));
    }

    #[test]
    fn prev_steps_back() {
        assert_eq!(prev_index(2, 3), Some(1));
    }

    #[test]
    fn prev_on_empty_queue_is_none() {
        assert_eq!(prev_index(0, 0), None);
    }

    #[test]
    fn track_end_replays_under_repeat_one() {
        assert!(matches!(on_track_end(1, 3, RepeatMode::One), EndAction::Replay));
    }

    #[test]
    fn track_end_loops_under_repeat_all() {
        assert!(matches!(
            on_track_end(2, 3, RepeatMode::All),
            EndAction::Advance(0)
        ));
    }

    #[test]
    fn track_end_stops_at_the_end_when_off() {
        assert!(matches!(on_track_end(2, 3, RepeatMode::Off), EndAction::Stop));
    }

    #[test]
    fn track_end_advances_in_the_middle() {
        assert!(matches!(
            on_track_end(0, 3, RepeatMode::Off),
            EndAction::Advance(1)
        ));
    }

    // ---- Index clamp ----

    #[test]
    fn clamp_index_caps_at_the_last_track() {
        assert_eq!(clamp_index(9, 3), 2);
    }

    #[test]
    fn clamp_index_leaves_an_in_range_index() {
        assert_eq!(clamp_index(1, 3), 1);
    }

    #[test]
    fn clamp_index_on_an_empty_queue_is_zero() {
        assert_eq!(clamp_index(4, 0), 0);
    }

    // ---- Shuffle ----

    #[test]
    fn shuffle_order_is_deterministic_for_a_seed() {
        let mut a = Xorshift::new(42);
        let mut b = Xorshift::new(42);
        assert_eq!(shuffle_order(8, 3, &mut a), shuffle_order(8, 3, &mut b));
    }

    #[test]
    fn shuffle_order_pins_the_chosen_index_at_the_front() {
        let mut rng = Xorshift::new(7);
        let order = shuffle_order(10, 4, &mut rng);
        assert_eq!(order[0], 4);
    }

    #[test]
    fn shuffle_order_is_a_valid_permutation() {
        let mut rng = Xorshift::new(123);
        let mut order = shuffle_order(12, 5, &mut rng);
        order.sort_unstable();
        assert_eq!(order, (0..12).collect::<Vec<usize>>());
    }

    #[test]
    fn shuffle_order_empty_is_empty() {
        let mut rng = Xorshift::new(1);
        assert!(shuffle_order(0, 0, &mut rng).is_empty());
    }

    #[test]
    fn shuffle_order_single_is_the_index() {
        let mut rng = Xorshift::new(1);
        assert_eq!(shuffle_order(1, 0, &mut rng), vec![0]);
    }

    #[test]
    fn shuffle_order_clamps_an_over_range_pin() {
        let mut rng = Xorshift::new(1);
        let mut order = shuffle_order(4, 9, &mut rng);
        assert_eq!(order[0], 3);
        order.sort_unstable();
        assert_eq!(order, vec![0, 1, 2, 3]);
    }

    #[test]
    fn shuffle_then_restore_round_trips_the_order() {
        // The ordering half of a shuffle toggle, sink aside: materialize a shuffled order pinning the
        // current track to the front, then restore the captured original and re-locate by id.
        let original: Vec<i64> = vec![10, 20, 30, 40, 50];
        let current = 2usize; // playing id 30
        let mut rng = Xorshift::new(99);

        let order = shuffle_order(original.len(), current, &mut rng);
        let shuffled: Vec<i64> = order.iter().map(|&i| original[i]).collect();
        assert_eq!(shuffled[0], 30);

        let mut got = shuffled.clone();
        let mut want = original.clone();
        got.sort_unstable();
        want.sort_unstable();
        assert_eq!(got, want);

        let restored = original.clone();
        let idx = restored.iter().position(|&id| id == 30).unwrap();
        assert_eq!(restored, vec![10, 20, 30, 40, 50]);
        assert_eq!(idx, 2);
    }

    // ---- Queue mutation ----

    // A queue track with a given id and an empty path: the mutation helpers key on id and never touch
    // the path.
    fn qtrack(id: i64) -> QueueTrack {
        QueueTrack {
            id,
            path: PathBuf::new(),
            gain_db: 0.0,
        }
    }

    fn ids(queue: &[QueueTrack]) -> Vec<i64> {
        queue.iter().map(|t| t.id).collect()
    }

    #[test]
    fn enqueue_grows_queue_and_original_order() {
        let mut queue = vec![qtrack(10), qtrack(20)];
        let mut original = vec![qtrack(10), qtrack(20)];
        let first_new = enqueue_tracks(&mut queue, &mut original, vec![qtrack(30), qtrack(40)]);
        assert_eq!(first_new, 2);
        assert_eq!(ids(&queue), vec![10, 20, 30, 40]);
        assert_eq!(ids(&original), vec![10, 20, 30, 40]);
    }

    #[test]
    fn insert_unshuffled_lands_after_current_and_rebaselines() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        let at = insert_after_current(
            &mut queue,
            &mut original,
            false,
            0,
            Some(10),
            vec![qtrack(91), qtrack(92)],
        );
        assert_eq!(at, 1);
        assert_eq!(ids(&queue), vec![10, 91, 92, 20, 30]);
        assert_eq!(ids(&original), vec![10, 91, 92, 20, 30]);
    }

    #[test]
    fn insert_shuffled_lands_after_current_in_both_orders() {
        // Play order 30, 10, 20 over pristine 10, 20, 30; id 30 plays.
        let mut queue = vec![qtrack(30), qtrack(10), qtrack(20)];
        let mut original = vec![qtrack(10), qtrack(20), qtrack(30)];
        let at = insert_after_current(
            &mut queue,
            &mut original,
            true,
            0,
            Some(30),
            vec![qtrack(91), qtrack(92)],
        );
        assert_eq!(at, 1);
        assert_eq!(ids(&queue), vec![30, 91, 92, 10, 20]);
        assert_eq!(ids(&original), vec![10, 20, 30, 91, 92]);
        // Shuffle off restores the pristine order and the cursor finds id 30: the inserts stay next.
        let index = reseat_index(&original, Some(30), 0);
        assert_eq!(ids(&original)[index + 1..index + 3], [91, 92]);
    }

    #[test]
    fn insert_shuffled_mid_pristine_keeps_inserts_next_after_shuffle_off() {
        let mut queue = vec![qtrack(20), qtrack(30), qtrack(10)];
        let mut original = vec![qtrack(10), qtrack(20), qtrack(30)];
        insert_after_current(&mut queue, &mut original, true, 0, Some(20), vec![qtrack(91)]);
        assert_eq!(ids(&original), vec![10, 20, 91, 30]);
    }

    #[test]
    fn insert_into_empty_queue_is_a_cold_start() {
        let mut queue = Vec::new();
        let mut original = Vec::new();
        let at = insert_after_current(
            &mut queue,
            &mut original,
            false,
            0,
            None,
            vec![qtrack(91), qtrack(92)],
        );
        assert_eq!(at, 0);
        assert_eq!(ids(&queue), vec![91, 92]);
        assert_eq!(ids(&original), vec![91, 92]);
    }

    #[test]
    fn insert_on_the_last_track_appends_after_it() {
        let mut queue = vec![qtrack(10), qtrack(20)];
        let mut original = queue.clone();
        let at = insert_after_current(&mut queue, &mut original, false, 1, Some(20), vec![qtrack(91)]);
        assert_eq!(at, 2);
        assert_eq!(ids(&queue), vec![10, 20, 91]);
        // The insert becomes the next track, so a preloaded wrap target is stale.
        assert_eq!(pending_slot(&queue, 1, RepeatMode::All, 10), None);
        assert_eq!(pending_slot(&queue, 1, RepeatMode::Off, 91), Some(2));
    }

    #[test]
    fn move_out_of_range_from_is_a_no_op() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        assert!(!move_queue_item(&mut queue, &mut original, false, 3, 0));
        assert_eq!(ids(&queue), vec![10, 20, 30]);
    }

    #[test]
    fn move_same_slot_is_a_no_op() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        assert!(!move_queue_item(&mut queue, &mut original, false, 1, 1));
        assert_eq!(ids(&queue), vec![10, 20, 30]);
    }

    #[test]
    fn move_unshuffled_rebaselines_original_order() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        assert!(move_queue_item(&mut queue, &mut original, false, 0, 2));
        assert_eq!(ids(&queue), vec![20, 30, 10]);
        // Unshuffled, the pristine order follows the user's new order.
        assert_eq!(ids(&original), vec![20, 30, 10]);
    }

    #[test]
    fn move_shuffled_leaves_original_order_pristine() {
        let mut queue = vec![qtrack(30), qtrack(10), qtrack(20)];
        let mut original = vec![qtrack(10), qtrack(20), qtrack(30)];
        assert!(move_queue_item(&mut queue, &mut original, true, 0, 2));
        assert_eq!(ids(&queue), vec![10, 20, 30]);
        // Shuffled, a reorder is ephemeral: the pristine order is untouched.
        assert_eq!(ids(&original), vec![10, 20, 30]);
    }

    #[test]
    fn reseat_tracks_the_playing_id_across_a_move() {
        // Playing id 10, moved from the front to the back: the cursor follows it to its new slot.
        let queue = vec![qtrack(20), qtrack(30), qtrack(10)];
        assert_eq!(reseat_index(&queue, Some(10), 0), 2);
    }

    #[test]
    fn reseat_falls_back_to_a_clamped_index_when_id_is_gone() {
        let queue = vec![qtrack(20), qtrack(30)];
        // Nothing playing: clamp the old cursor into the shortened queue.
        assert_eq!(reseat_index(&queue, None, 5), 1);
    }

    #[test]
    fn remove_non_current_shrinks_and_reseats() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        // Playing id 30 (cursor 2); remove up-next id 10.
        let removed = remove_queue_item(&mut queue, &mut original, false, 0);
        assert_eq!(removed, Some(10));
        assert_eq!(ids(&queue), vec![20, 30]);
        assert_eq!(ids(&original), vec![20, 30]);
        // The cursor re-seats onto id 30's new slot.
        assert_eq!(reseat_index(&queue, Some(30), 2), 1);
    }

    #[test]
    fn remove_out_of_range_index_is_a_no_op() {
        let mut queue = vec![qtrack(10), qtrack(20)];
        let mut original = queue.clone();
        assert_eq!(remove_queue_item(&mut queue, &mut original, false, 2), None);
        assert_eq!(ids(&queue), vec![10, 20]);
        assert_eq!(ids(&original), vec![10, 20]);
    }

    #[test]
    fn remove_shuffled_drops_one_pristine_entry_by_id() {
        let mut queue = vec![qtrack(30), qtrack(10), qtrack(20)];
        let mut original = vec![qtrack(10), qtrack(20), qtrack(30)];
        let removed = remove_queue_item(&mut queue, &mut original, true, 0);
        assert_eq!(removed, Some(30));
        assert_eq!(ids(&queue), vec![10, 20]);
        // Shuffled: the pristine order drops the removed id in place, staying pristine otherwise.
        assert_eq!(ids(&original), vec![10, 20]);
    }

    // ---- Preload target and validation ----

    #[test]
    fn preload_targets_the_next_slot_when_off() {
        assert_eq!(preload_target(0, 3, RepeatMode::Off), Some(1));
        assert_eq!(preload_target(2, 3, RepeatMode::Off), None);
    }

    #[test]
    fn preload_wraps_under_repeat_all() {
        assert_eq!(preload_target(1, 3, RepeatMode::All), Some(2));
        assert_eq!(preload_target(2, 3, RepeatMode::All), Some(0));
    }

    #[test]
    fn preload_targets_the_same_slot_under_repeat_one() {
        assert_eq!(preload_target(1, 3, RepeatMode::One), Some(1));
        assert_eq!(preload_target(2, 3, RepeatMode::One), Some(2));
    }

    #[test]
    fn preload_on_an_empty_queue_is_none() {
        for repeat in [RepeatMode::Off, RepeatMode::All, RepeatMode::One] {
            assert_eq!(preload_target(0, 0, repeat), None);
        }
    }

    #[test]
    fn preload_agrees_with_the_cold_end() {
        for repeat in [RepeatMode::Off, RepeatMode::All, RepeatMode::One] {
            for index in 0..4 {
                let cold = match on_track_end(index, 4, repeat) {
                    EndAction::Replay => Some(index),
                    EndAction::Advance(i) => Some(i),
                    EndAction::Stop => None,
                };
                assert_eq!(preload_target(index, 4, repeat), cold);
            }
        }
    }

    #[test]
    fn pending_holds_while_its_slot_is_unchanged() {
        let queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        assert_eq!(pending_slot(&queue, 0, RepeatMode::Off, 20), Some(1));
    }

    #[test]
    fn pending_is_stale_after_a_repeat_change() {
        let queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        // Armed for id 20 behind id 10; repeat-one now replays id 10 instead.
        assert_eq!(pending_slot(&queue, 0, RepeatMode::One, 20), None);
        // Armed for id 10 replaying itself; turning repeat-one off moves on to id 20.
        assert_eq!(pending_slot(&queue, 0, RepeatMode::Off, 10), None);
        // Armed at the end under repeat-all; repeat off stops there instead.
        assert_eq!(pending_slot(&queue, 2, RepeatMode::All, 10), Some(0));
        assert_eq!(pending_slot(&queue, 2, RepeatMode::Off, 10), None);
    }

    #[test]
    fn pending_is_stale_after_a_shuffle() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30), qtrack(40), qtrack(50)];
        // Playing id 10 with id 20 armed. Seed 3 puts a different track behind the pinned one.
        let order = shuffle_order(queue.len(), 0, &mut Xorshift::new(3));
        queue = order.into_iter().map(|i| queue[i].clone()).collect();
        assert_eq!(queue[0].id, 10);
        assert_ne!(queue[1].id, 20);
        assert_eq!(pending_slot(&queue, 0, RepeatMode::Off, 20), None);
    }

    #[test]
    fn pending_follows_its_track_when_an_earlier_slot_moves() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30), qtrack(40)];
        let mut original = queue.clone();
        // Playing id 20 (slot 1) with id 30 armed (slot 2). Moving the played id 10 behind them
        // shifts both up one slot, and the preload stays valid at its new slot.
        assert!(move_queue_item(&mut queue, &mut original, false, 0, 3));
        let index = reseat_index(&queue, Some(20), 1);
        assert_eq!(index, 0);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 30), Some(1));
    }

    #[test]
    fn pending_is_stale_when_another_track_moves_into_its_slot() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30), qtrack(40)];
        let mut original = queue.clone();
        // Playing id 10 with id 20 armed; id 40 is dragged to play next.
        assert!(move_queue_item(&mut queue, &mut original, false, 3, 1));
        let index = reseat_index(&queue, Some(10), 0);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 20), None);
    }

    #[test]
    fn pending_is_stale_when_its_track_is_removed() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        // Playing id 10 with id 20 armed; id 20 is removed and id 30 slides in.
        assert_eq!(
            remove_queue_item(&mut queue, &mut original, false, 1),
            Some(20)
        );
        let index = reseat_index(&queue, Some(10), 0);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 20), None);
    }

    #[test]
    fn pending_follows_its_track_when_a_played_track_is_removed() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        // Playing id 20 with id 30 armed; the played id 10 is removed.
        remove_queue_item(&mut queue, &mut original, false, 0);
        let index = reseat_index(&queue, Some(20), 1);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 30), Some(1));
    }

    #[test]
    fn pending_is_stale_when_a_track_is_inserted_before_it() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        // Playing id 10 with id 20 armed; id 99 is inserted to play next.
        queue.insert(1, qtrack(99));
        let index = reseat_index(&queue, Some(10), 0);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 20), None);
    }

    #[test]
    fn an_append_keeps_a_pending_target_or_supersedes_the_wrap() {
        let mut queue = vec![qtrack(10), qtrack(20)];
        let mut original = queue.clone();
        enqueue_tracks(&mut queue, &mut original, vec![qtrack(30)]);
        // Playing id 10 with id 20 armed: an append lands behind it.
        assert_eq!(pending_slot(&queue, 0, RepeatMode::Off, 20), Some(1));
        // Playing the last id 20 under repeat-all with id 10 armed: the appended id 30 now plays next.
        assert_eq!(pending_slot(&queue, 1, RepeatMode::All, 10), None);
    }
}
