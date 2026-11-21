/*
 * The pure queue motion and shuffle helpers behind the engine: cursor moves, queue edits that keep the
 * pristine order in step, and a seeded shuffle. No sink, no device, no clock, so every rule tests on
 * plain values.
 *
 * The attached members of a block stay contiguous in both orders through every edit, in album order
 * in the pristine one. The same track id can sit in the queue more than once, so a copy is named by
 * its (id, token) pair wherever one copy has to be told from another; a token never changes, and a
 * member dragged out of its block is marked detached instead.
 */

// -- Library Imports --
use std::collections::HashMap;

// -- Local Imports --
use super::{QueueTrack, RepeatMode};

/// One queue copy: a track id and its block token.
pub(crate) type Anchor = (i64, Option<u64>);

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

/// The slot holding track `id`, or None when it is absent. The first match wins for a repeated id.
pub(crate) fn index_of_id(queue: &[QueueTrack], id: i64) -> Option<usize> {
    queue.iter().position(|t| t.id == id)
}

/// The slot holding the copy `id` with token `block`. The first match wins for a repeated loose copy.
pub(crate) fn index_of_copy(queue: &[QueueTrack], (id, block): Anchor) -> Option<usize> {
    queue.iter().position(|t| t.id == id && t.block == block)
}

/// The block `track` plays in: its token unless it was dragged out of the block.
fn member_of(track: &QueueTrack) -> Option<u64> {
    track.block.filter(|_| !track.detached)
}

/// The end, exclusive, of the unit holding slot `i`: its block's last attached member plus one, or
/// `i + 1` for a loose or detached track. Clamped to the queue's length.
fn unit_end(queue: &[QueueTrack], i: usize) -> usize {
    let Some(block) = queue.get(i).and_then(member_of) else {
        return (i + 1).min(queue.len());
    };
    let mut end = i + 1;
    while queue.get(end).is_some_and(|t| member_of(t) == Some(block)) {
        end += 1;
    }
    end
}

/// The slots `[start, end)` the attached members of block `block` hold, or None when it has none.
fn block_range(queue: &[QueueTrack], block: u64) -> Option<(usize, usize)> {
    let start = queue.iter().position(|t| member_of(t) == Some(block))?;
    Some((start, unit_end(queue, start)))
}

/// Where a track dropped at slot `at` lands: after the block when `at` falls between two of its
/// members, else at `at`.
fn outside_blocks(queue: &[QueueTrack], at: usize) -> usize {
    let before = at.checked_sub(1).and_then(|i| queue.get(i)).and_then(member_of);
    let after = queue.get(at).and_then(member_of);
    if before.is_some() && before == after {
        unit_end(queue, at)
    } else {
        at
    }
}

/// Swaps the batch-local marks on `tracks` for tokens drawn from `next`, one per run of equal marks,
/// so a block is contiguous by construction and the same album sent twice is two blocks. The engine's
/// only source of tokens, so they stay unique across every queue it builds.
pub(crate) fn mint_blocks(tracks: &mut [QueueTrack], next: &mut u64) {
    let mut run: Option<(u64, u64)> = None;
    for track in tracks.iter_mut() {
        track.detached = false;
        let Some(mark) = track.block else {
            run = None;
            continue;
        };
        let token = match run {
            Some((m, token)) if m == mark => token,
            _ => {
                let token = *next;
                *next += 1;
                run = Some((mark, token));
                token
            }
        };
        track.block = Some(token);
    }
}

/// Each block of `queue` with at least two attached members, as a `[start, length]` span over its
/// slots, in queue order. A lone member keeps its token but reads as a plain track.
pub(crate) fn block_spans(queue: &[QueueTrack]) -> Vec<[usize; 2]> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < queue.len() {
        let end = unit_end(queue, i);
        if end - i > 1 {
            spans.push([i, end - i]);
        }
        i = end;
    }
    spans
}

/// The cursor after the row at `from` moved to `dest`: the moved row's new slot when it was the
/// cursor's row, else the cursor's row shifted by the move.
pub(crate) fn index_after_move(cursor: usize, from: usize, dest: usize) -> usize {
    if from == cursor {
        return dest;
    }
    let shortened = if from < cursor { cursor - 1 } else { cursor };
    if dest <= shortened {
        shortened + 1
    } else {
        shortened
    }
}

/// The cursor after the row at `removed` left a queue now `len` long: its row shifted down when the
/// removed row was before it, clamped into the queue.
pub(crate) fn index_after_remove(cursor: usize, removed: usize, len: usize) -> usize {
    let shifted = if removed < cursor { cursor - 1 } else { cursor };
    clamp_index(shifted, len)
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

/// Inserts `tracks` right after the playing copy `anchor` at `index`, or after the end of its block,
/// in the caller's order. Unshuffled, the pristine order is rebaselined to the new queue. Shuffled,
/// the tracks land the same way after the playing copy's pristine slot (or last when it has none),
/// so turning shuffle off keeps them next. With no playing track they append like a cold-start
/// enqueue. Returns the queue index of the first inserted track.
pub(crate) fn insert_after_current(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    shuffle: bool,
    index: usize,
    anchor: Option<Anchor>,
    tracks: Vec<QueueTrack>,
) -> usize {
    let at = match anchor {
        Some(_) => unit_end(queue, index),
        None => queue.len(),
    };
    queue.splice(at..at, tracks.iter().cloned());
    if !shuffle {
        *original_order = queue.clone();
    } else {
        let pristine_at = anchor
            .and_then(|copy| index_of_copy(original_order, copy))
            .map_or(original_order.len(), |pos| unit_end(original_order, pos));
        original_order.splice(pristine_at..pristine_at, tracks);
    }
    at
}

/// Moves the queue item at `from` to `to` and returns the slot it landed on. A block member dropped
/// within its block's span, ends included, is attached there, a detached one again; dropped anywhere
/// else it is detached. A track that is not a member of the block it is dropped into lands after
/// that block. An unshuffled reorder rebaselines the pristine order to the new order; a shuffled
/// reorder leaves it pristine, so a detach there holds in the play order only. A re-attach under
/// shuffle touches the play order only too: a row detached with shuffle off and re-attached under
/// shuffle is detached again once shuffle is off. Returns None without changing anything when the
/// queue is empty, `from` is out of range, or `from == to`. Never clamps `from`: a stale over-range
/// index would move the wrong track.
pub(crate) fn move_queue_item(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    shuffle: bool,
    from: usize,
    to: usize,
) -> Option<usize> {
    let len = queue.len();
    if len == 0 || from >= len || from == to {
        return None;
    }
    let mut item = queue.remove(from);
    let mut dest = to.min(queue.len());
    let own = item.block.and_then(|block| block_range(queue, block));
    if own.is_some_and(|(start, end)| (start..=end).contains(&dest)) {
        item.detached = false;
    } else {
        if own.is_some() {
            item.detached = true;
        }
        dest = outside_blocks(queue, dest);
    }
    queue.insert(dest, item);
    if !shuffle {
        *original_order = queue.clone();
    }
    Some(dest)
}

/// Removes the queue item at `index` and keeps the pristine order in step: an unshuffled remove
/// rebaselines the pristine order to the shortened queue, a shuffled remove drops the removed copy's
/// pristine entry. Returns the removed track's id, or None when `index` is out of range.
pub(crate) fn remove_queue_item(
    queue: &mut Vec<QueueTrack>,
    original_order: &mut Vec<QueueTrack>,
    shuffle: bool,
    index: usize,
) -> Option<i64> {
    if index >= queue.len() {
        return None;
    }
    let removed = queue.remove(index);
    if !shuffle {
        *original_order = queue.clone();
    } else if let Some(pos) = index_of_copy(original_order, (removed.id, removed.block)) {
        original_order.remove(pos);
    }
    Some(removed.id)
}

/// The play-cursor position after a queue mutation: the slot of the playing copy `anchor`, or a
/// clamped fallback from `current` when nothing plays or the track is gone. Keeps advance/prev/
/// on_track_end stepping from the right slot without touching the sink.
pub(crate) fn reseat_index(queue: &[QueueTrack], anchor: Option<Anchor>, current: usize) -> usize {
    let fallback = current.min(queue.len().saturating_sub(1));
    anchor
        .and_then(|copy| index_of_copy(queue, copy))
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
    pub(super) fn below(&mut self, bound: usize) -> usize {
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

/// A shuffled order of `queue` over units, with the cursor's new slot. A unit is every attached
/// member of one block in queue order, or one loose or detached track. The unit holding `pin` goes
/// first and the others follow in `shuffle_order`'s order, so the playing track keeps the rest of its
/// block behind it and the members before it read as played. `pin` is clamped into range; an empty
/// queue yields an empty order and cursor 0, and a queue that is one block keeps its order with the
/// cursor on `pin`.
pub(crate) fn unit_shuffle_order(
    queue: &[QueueTrack],
    pin: usize,
    rng: &mut Xorshift,
) -> (Vec<usize>, usize) {
    if queue.is_empty() {
        return (Vec::new(), 0);
    }
    let pin = pin.min(queue.len() - 1);
    let mut units: Vec<Vec<usize>> = Vec::new();
    let mut unit_of: HashMap<u64, usize> = HashMap::new();
    let mut pinned = 0;
    for (i, track) in queue.iter().enumerate() {
        let unit = match member_of(track) {
            Some(block) => *unit_of.entry(block).or_insert_with(|| {
                units.push(Vec::new());
                units.len() - 1
            }),
            None => {
                units.push(Vec::new());
                units.len() - 1
            }
        };
        units[unit].push(i);
        if i == pin {
            pinned = unit;
        }
    }
    let cursor = units[pinned].iter().position(|&i| i == pin).unwrap_or(0);
    let mut order = Vec::with_capacity(queue.len());
    for unit in shuffle_order(units.len(), pinned, rng) {
        order.extend_from_slice(&units[unit]);
    }
    (order, cursor)
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

    // ---- Id lookup ----

    #[test]
    fn index_of_id_finds_the_slot() {
        let q = vec![qtrack(4), qtrack(9), qtrack(2)];
        assert_eq!(index_of_id(&q, 9), Some(1));
    }

    #[test]
    fn index_of_id_is_none_when_absent() {
        assert_eq!(index_of_id(&[qtrack(4)], 7), None);
    }

    #[test]
    fn index_of_id_takes_the_first_of_a_repeat() {
        let q = vec![qtrack(4), qtrack(9), qtrack(9)];
        assert_eq!(index_of_id(&q, 9), Some(1));
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
            block: None,
            detached: false,
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
            Some((10, None)),
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
            Some((30, None)),
            vec![qtrack(91), qtrack(92)],
        );
        assert_eq!(at, 1);
        assert_eq!(ids(&queue), vec![30, 91, 92, 10, 20]);
        assert_eq!(ids(&original), vec![10, 20, 30, 91, 92]);
        // Shuffle off restores the pristine order and the cursor finds id 30: the inserts stay next.
        let index = reseat_index(&original, Some((30, None)), 0);
        assert_eq!(ids(&original)[index + 1..index + 3], [91, 92]);
    }

    #[test]
    fn insert_shuffled_mid_pristine_keeps_inserts_next_after_shuffle_off() {
        let mut queue = vec![qtrack(20), qtrack(30), qtrack(10)];
        let mut original = vec![qtrack(10), qtrack(20), qtrack(30)];
        insert_after_current(&mut queue, &mut original, true, 0, Some((20, None)), vec![qtrack(91)]);
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
        let at = insert_after_current(&mut queue, &mut original, false, 1, Some((20, None)), vec![qtrack(91)]);
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
        assert!(move_queue_item(&mut queue, &mut original, false, 3, 0).is_none());
        assert_eq!(ids(&queue), vec![10, 20, 30]);
    }

    #[test]
    fn move_same_slot_is_a_no_op() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        assert!(move_queue_item(&mut queue, &mut original, false, 1, 1).is_none());
        assert_eq!(ids(&queue), vec![10, 20, 30]);
    }

    #[test]
    fn move_unshuffled_rebaselines_original_order() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 0, 2), Some(2));
        assert_eq!(ids(&queue), vec![20, 30, 10]);
        // Unshuffled, the pristine order follows the user's new order.
        assert_eq!(ids(&original), vec![20, 30, 10]);
    }

    #[test]
    fn move_shuffled_leaves_original_order_pristine() {
        let mut queue = vec![qtrack(30), qtrack(10), qtrack(20)];
        let mut original = vec![qtrack(10), qtrack(20), qtrack(30)];
        assert!(move_queue_item(&mut queue, &mut original, true, 0, 2).is_some());
        assert_eq!(ids(&queue), vec![10, 20, 30]);
        // Shuffled, a reorder is ephemeral: the pristine order is untouched.
        assert_eq!(ids(&original), vec![10, 20, 30]);
    }

    #[test]
    fn reseat_tracks_the_playing_id_across_a_move() {
        // Playing id 10, moved from the front to the back: the cursor follows it to its new slot.
        let queue = vec![qtrack(20), qtrack(30), qtrack(10)];
        assert_eq!(reseat_index(&queue, Some((10, None)), 0), 2);
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
        assert_eq!(reseat_index(&queue, Some((30, None)), 2), 1);
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
        assert!(move_queue_item(&mut queue, &mut original, false, 0, 3).is_some());
        let index = reseat_index(&queue, Some((20, None)), 1);
        assert_eq!(index, 0);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 30), Some(1));
    }

    #[test]
    fn pending_is_stale_when_another_track_moves_into_its_slot() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30), qtrack(40)];
        let mut original = queue.clone();
        // Playing id 10 with id 20 armed; id 40 is dragged to play next.
        assert!(move_queue_item(&mut queue, &mut original, false, 3, 1).is_some());
        let index = reseat_index(&queue, Some((10, None)), 0);
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
        let index = reseat_index(&queue, Some((10, None)), 0);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 20), None);
    }

    #[test]
    fn pending_follows_its_track_when_a_played_track_is_removed() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        let mut original = queue.clone();
        // Playing id 20 with id 30 armed; the played id 10 is removed.
        remove_queue_item(&mut queue, &mut original, false, 0);
        let index = reseat_index(&queue, Some((20, None)), 1);
        assert_eq!(pending_slot(&queue, index, RepeatMode::Off, 30), Some(1));
    }

    #[test]
    fn pending_is_stale_when_a_track_is_inserted_before_it() {
        let mut queue = vec![qtrack(10), qtrack(20), qtrack(30)];
        // Playing id 10 with id 20 armed; id 99 is inserted to play next.
        queue.insert(1, qtrack(99));
        let index = reseat_index(&queue, Some((10, None)), 0);
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

    // ---- Blocks ----

    // A queue track in block `block`.
    fn btrack(id: i64, block: u64) -> QueueTrack {
        QueueTrack {
            block: Some(block),
            ..qtrack(id)
        }
    }

    fn copies(queue: &[QueueTrack]) -> Vec<Anchor> {
        queue.iter().map(|t| (t.id, t.block)).collect()
    }

    fn reorder(queue: &[QueueTrack], order: &[usize]) -> Vec<QueueTrack> {
        order.iter().map(|&i| queue[i].clone()).collect()
    }

    #[test]
    fn mint_blocks_gives_each_intake_and_each_run_its_own_token() {
        let mut next = 5;
        let mut first = vec![btrack(1, 0), btrack(2, 0), qtrack(3)];
        let mut second = vec![btrack(1, 0), btrack(2, 0), qtrack(3)];
        mint_blocks(&mut first, &mut next);
        mint_blocks(&mut second, &mut next);
        // The same album sent twice is two blocks.
        assert_eq!(copies(&first), vec![(1, Some(5)), (2, Some(5)), (3, None)]);
        assert_eq!(copies(&second), vec![(1, Some(6)), (2, Some(6)), (3, None)]);

        // Adjacent spans and a mark cut by a loose track are separate blocks.
        let mut batch = vec![btrack(1, 0), btrack(2, 1), qtrack(3), btrack(4, 1)];
        mint_blocks(&mut batch, &mut next);
        let tokens: Vec<Option<u64>> = batch.iter().map(|t| t.block).collect();
        assert_eq!(tokens, vec![Some(7), Some(8), None, Some(9)]);
        assert_eq!(next, 10);
    }

    #[test]
    fn block_spans_lists_each_run_of_two_or_more() {
        let queue = vec![qtrack(1), btrack(2, 7), btrack(3, 7), qtrack(4), btrack(5, 8)];
        assert_eq!(block_spans(&queue), vec![[1, 2]]);
        assert!(block_spans(&[qtrack(1)]).is_empty());
    }

    #[test]
    fn a_lone_member_keeps_its_token_but_is_not_a_block() {
        let mut queue = vec![qtrack(1), btrack(2, 7), btrack(3, 7), qtrack(4)];
        let mut original = queue.clone();
        remove_queue_item(&mut queue, &mut original, false, 1);
        assert!(block_spans(&queue).is_empty());
        assert_eq!(copies(&queue)[1], (3, Some(7)));
        // A one-track album is no band either.
        assert!(block_spans(&[btrack(9, 4), qtrack(1)]).is_empty());
    }

    #[test]
    fn an_empty_and_a_one_block_queue_shuffle_without_a_panic() {
        let mut rng = Xorshift::new(1);
        assert_eq!(unit_shuffle_order(&[], 3, &mut rng), (Vec::new(), 0));
        let album = vec![btrack(1, 4), btrack(2, 4), btrack(3, 4), btrack(4, 4)];
        assert_eq!(unit_shuffle_order(&album, 2, &mut rng), (vec![0, 1, 2, 3], 2));
        // An over-range pin is clamped to the last track.
        assert_eq!(unit_shuffle_order(&album, 9, &mut rng), (vec![0, 1, 2, 3], 3));
    }

    #[test]
    fn shuffle_on_mid_block_pins_the_whole_block() {
        // Loose 1, album 2-3-4, loose 5 and 6, album 8-9; id 3 plays.
        let queue = vec![
            qtrack(1),
            btrack(2, 7),
            btrack(3, 7),
            btrack(4, 7),
            qtrack(5),
            qtrack(6),
            btrack(8, 9),
            btrack(9, 9),
        ];
        for seed in 0..50 {
            let (order, cursor) = unit_shuffle_order(&queue, 2, &mut Xorshift::new(seed));
            let shuffled = reorder(&queue, &order);
            // The whole block comes first, the played member behind the cursor.
            assert_eq!(ids(&shuffled[..3]), vec![2, 3, 4], "seed {seed}");
            assert_eq!(cursor, 1);
            let mut sorted = order.clone();
            sorted.sort_unstable();
            assert_eq!(sorted, (0..8).collect::<Vec<usize>>());
            assert_eq!(block_spans(&shuffled).len(), 2, "seed {seed}");
        }
        // A loose current track is a unit of one.
        let (order, cursor) = unit_shuffle_order(&queue, 4, &mut Xorshift::new(3));
        assert_eq!((order[0], cursor), (4, 0));
    }

    #[test]
    fn a_preload_for_the_next_member_survives_a_shuffle_toggle() {
        let queue = vec![
            qtrack(1),
            btrack(2, 7),
            btrack(3, 7),
            btrack(4, 7),
            qtrack(5),
            qtrack(6),
            qtrack(10),
        ];
        // Playing id 3 with id 4 armed: the preload holds whatever the shuffle draws.
        assert_eq!(pending_slot(&queue, 2, RepeatMode::Off, 4), Some(3));
        for seed in 0..20 {
            let (order, cursor) = unit_shuffle_order(&queue, 2, &mut Xorshift::new(seed));
            let shuffled = reorder(&queue, &order);
            assert_eq!(pending_slot(&shuffled, cursor, RepeatMode::Off, 4), Some(cursor + 1));
        }
        // Playing loose id 5 with id 6 armed: some shuffle draws another track behind it.
        let stale = (0..20).any(|seed| {
            let (order, cursor) = unit_shuffle_order(&queue, 4, &mut Xorshift::new(seed));
            pending_slot(&reorder(&queue, &order), cursor, RepeatMode::Off, 6).is_none()
        });
        assert!(stale);
    }

    #[test]
    fn insert_next_inside_a_block_lands_after_it() {
        // Unshuffled: id 3 plays inside album 2-3-4.
        let mut queue = vec![qtrack(1), btrack(2, 7), btrack(3, 7), btrack(4, 7), qtrack(5)];
        let mut original = queue.clone();
        let at = insert_after_current(&mut queue, &mut original, false, 2, Some((3, Some(7))), vec![qtrack(91)]);
        assert_eq!(at, 4);
        assert_eq!(ids(&queue), vec![1, 2, 3, 4, 91, 5]);
        assert_eq!(copies(&original), copies(&queue));

        // Shuffled: the play order puts the block first; the pristine order keeps it second.
        let mut queue = vec![btrack(2, 7), btrack(3, 7), btrack(4, 7), qtrack(5), qtrack(1)];
        let mut original = vec![qtrack(1), btrack(2, 7), btrack(3, 7), btrack(4, 7), qtrack(5)];
        let at = insert_after_current(&mut queue, &mut original, true, 1, Some((3, Some(7))), vec![qtrack(91)]);
        assert_eq!(at, 3);
        assert_eq!(ids(&queue), vec![2, 3, 4, 91, 5, 1]);
        assert_eq!(ids(&original), vec![1, 2, 3, 4, 91, 5]);
        // Shuffle off keeps the insert right after the album.
        let index = reseat_index(&original, Some((3, Some(7))), 1);
        assert_eq!(index, 2);
        assert_eq!(original[index + 2].id, 91);
    }

    #[test]
    fn a_loose_duplicate_of_a_member_is_told_apart_under_shuffle() {
        // A loose copy of id 5 sits before the album 5-6 in the pristine order; the album copy plays.
        let mut original = vec![qtrack(5), qtrack(7), btrack(5, 3), btrack(6, 3)];
        let mut queue = vec![btrack(5, 3), btrack(6, 3), qtrack(5), qtrack(7)];
        insert_after_current(&mut queue, &mut original, true, 0, Some((5, Some(3))), vec![qtrack(91)]);
        assert_eq!(ids(&queue), vec![5, 6, 91, 5, 7]);
        assert_eq!(ids(&original), vec![5, 7, 5, 6, 91]);

        // Removing the loose copy drops the loose pristine entry, not the album's.
        assert_eq!(remove_queue_item(&mut queue, &mut original, true, 3), Some(5));
        assert_eq!(copies(&original), vec![(7, None), (5, Some(3)), (6, Some(3)), (91, None)]);
        // Removing the album copy shrinks the album in place.
        remove_queue_item(&mut queue, &mut original, true, 0);
        assert_eq!(copies(&original), vec![(7, None), (6, Some(3)), (91, None)]);
    }

    #[test]
    fn a_drag_inside_a_block_under_shuffle_reorders_the_play_order_only() {
        let mut original = vec![qtrack(1), btrack(2, 7), btrack(3, 7), btrack(4, 7)];
        let mut queue = vec![btrack(2, 7), btrack(3, 7), btrack(4, 7), qtrack(1)];
        // Id 2 dragged to the end of its block.
        assert_eq!(move_queue_item(&mut queue, &mut original, true, 0, 2), Some(2));
        assert_eq!(copies(&queue), vec![(3, Some(7)), (4, Some(7)), (2, Some(7)), (1, None)]);
        assert_eq!(ids(&original), vec![1, 2, 3, 4]);
        // Shuffle off brings the album order back.
        queue = original.clone();
        assert_eq!(ids(&queue), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_move_keeps_detaches_or_lands_after_a_block() {
        let album = || vec![qtrack(1), btrack(2, 7), btrack(3, 7), btrack(4, 7), qtrack(5)];

        // Within the span, ends included: the token stays.
        let (mut queue, mut original) = (album(), album());
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 1, 3), Some(3));
        assert_eq!(copies(&queue), vec![(1, None), (3, Some(7)), (4, Some(7)), (2, Some(7)), (5, None)]);
        assert_eq!(copies(&original), copies(&queue));

        // Out of the span: the member is detached and keeps its token.
        let (mut queue, mut original) = (album(), album());
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 1, 4), Some(4));
        assert_eq!(copies(&queue), vec![(1, None), (3, Some(7)), (4, Some(7)), (5, None), (2, Some(7))]);
        assert!(queue[4].detached && original[4].detached);
        assert_eq!(block_spans(&original), vec![[1, 2]]);
        // Dropped back inside its block's span it is attached again.
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 4, 1), Some(1));
        assert!(!queue[1].detached);
        assert_eq!(block_spans(&queue), vec![[1, 3]]);

        // A foreign track dropped in the interior lands after the block.
        let (mut queue, mut original) = (album(), album());
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 4, 2), Some(4));
        assert_eq!(ids(&queue), vec![1, 2, 3, 4, 5]);
        // At the block's edge it lands where it was dropped.
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 4, 1), Some(1));
        assert_eq!(ids(&queue), vec![1, 5, 2, 3, 4]);

        // A member of one block dropped inside another leaves its own and lands after the other.
        let mut queue = vec![btrack(1, 3), btrack(2, 3), btrack(4, 7), btrack(5, 7), btrack(6, 7)];
        let mut original = queue.clone();
        assert_eq!(move_queue_item(&mut queue, &mut original, false, 0, 3), Some(4));
        assert_eq!(copies(&queue), vec![(2, Some(3)), (4, Some(7)), (5, Some(7)), (6, Some(7)), (1, Some(3))]);
        assert!(queue[4].detached);
    }

    #[test]
    fn a_member_detached_under_shuffle_stays_its_own_copy() {
        // The album 5-6 is queued twice beside a loose copy of id 5; the second album's id 5 plays.
        let mut original = vec![qtrack(5), btrack(5, 1), btrack(6, 1), btrack(5, 2), btrack(6, 2)];
        let mut queue = vec![btrack(5, 2), btrack(6, 2), qtrack(5), btrack(5, 1), btrack(6, 1)];
        // The playing member is dragged out of its block, after the loose copy.
        assert_eq!(move_queue_item(&mut queue, &mut original, true, 0, 2), Some(2));
        assert_eq!(copies(&queue)[2], (5, Some(2)));
        assert!(queue[2].detached && !original[3].detached);
        // Play next lands after the detached row and, in the pristine order, after its album.
        insert_after_current(&mut queue, &mut original, true, 2, Some((5, Some(2))), vec![qtrack(91)]);
        assert_eq!(ids(&queue), vec![6, 5, 5, 91, 5, 6]);
        assert_eq!(ids(&original), vec![5, 5, 6, 5, 6, 91]);
        // Removing the loose copy leaves the album copies alone in the pristine order.
        remove_queue_item(&mut queue, &mut original, true, 1);
        assert_eq!(copies(&original), vec![(5, Some(1)), (6, Some(1)), (5, Some(2)), (6, Some(2)), (91, None)]);
        // Shuffle off re-seats on the playing copy, attached again in its album.
        assert_eq!(reseat_index(&original, Some((5, Some(2))), 0), 2);
        assert!(original.iter().all(|t| !t.detached));
    }

    #[test]
    fn remove_shrinks_a_block_and_an_emptied_block_leaves_no_token() {
        let mut queue = vec![qtrack(1), btrack(2, 7), btrack(3, 7), btrack(4, 7)];
        let mut original = queue.clone();
        remove_queue_item(&mut queue, &mut original, false, 1);
        assert_eq!(block_spans(&queue), vec![[1, 2]]);
        remove_queue_item(&mut queue, &mut original, false, 1);
        remove_queue_item(&mut queue, &mut original, false, 1);
        assert!(block_spans(&queue).is_empty());
        assert!(queue.iter().chain(&original).all(|t| t.block.is_none()));
    }

    #[test]
    fn reseat_finds_the_playing_copy_of_an_album_queued_twice() {
        let original = vec![btrack(1, 1), btrack(2, 1), btrack(1, 2), btrack(2, 2)];
        // Shuffle off while the second copy's id 1 plays.
        assert_eq!(reseat_index(&original, Some((1, Some(2))), 0), 2);
        assert_eq!(reseat_index(&original, Some((1, Some(1))), 3), 0);
        // A copy no longer in the queue leaves the cursor clamped where it was.
        assert_eq!(reseat_index(&original, Some((2, None)), 9), 3);
    }

    #[test]
    fn the_cursor_follows_its_row_through_moves_and_removes() {
        // Cursor on slot 3: a row before it leaves or lands, and the cursor shifts with its row.
        assert_eq!(index_after_remove(3, 1, 5), 2);
        assert_eq!(index_after_remove(3, 4, 5), 3);
        assert_eq!(index_after_remove(3, 3, 3), 2);
        assert_eq!(index_after_move(3, 0, 4), 2);
        assert_eq!(index_after_move(3, 5, 1), 4);
        assert_eq!(index_after_move(3, 5, 4), 3);
        assert_eq!(index_after_move(3, 3, 0), 0);
    }

    // ---- Block property ----

    // The engine's queue state, driven through the same helpers the engine calls. Each row's path is a
    // serial of its own, so the model knows which row plays even among copies of one track.
    struct Model {
        queue: Vec<QueueTrack>,
        original: Vec<QueueTrack>,
        shuffle: bool,
        index: usize,
        anchor: Option<Anchor>,
        playing: Option<PathBuf>,
        next: u64,
        serial: u64,
        rng: Xorshift,
        // Each token's member order, from its intake or the last unshuffled reorder.
        album: HashMap<u64, Vec<i64>>,
    }

    impl Model {
        // One to three units with ids from a pool of six, so loose tracks repeat block members.
        fn batch(&mut self) -> Vec<QueueTrack> {
            let mut tracks = Vec::new();
            for mark in 0..1 + self.rng.below(3) as u64 {
                if self.rng.below(2) == 0 {
                    tracks.push(qtrack(1 + self.rng.below(6) as i64));
                    continue;
                }
                let first = self.rng.below(6) as i64;
                for k in 0..1 + self.rng.below(4) as i64 {
                    tracks.push(btrack(1 + (first + k) % 6, mark));
                }
            }
            mint_blocks(&mut tracks, &mut self.next);
            for t in tracks.iter_mut() {
                self.serial += 1;
                t.path = PathBuf::from(self.serial.to_string());
                if let Some(block) = t.block {
                    self.album.entry(block).or_default().push(t.id);
                }
            }
            tracks
        }

        // Starts the row at `i`, or nothing on an empty queue.
        fn seat(&mut self, i: usize) {
            self.index = i;
            self.anchor = self.queue.get(i).map(|t| (t.id, t.block));
            self.playing = self.queue.get(i).map(|t| t.path.clone());
        }

        fn shuffle_from(&mut self, pin: usize) {
            let (order, cursor) = unit_shuffle_order(&self.queue, pin, &mut self.rng);
            self.queue = reorder(&self.queue, &order);
            self.index = cursor;
        }

        fn rebaseline_albums(&mut self) {
            self.album.clear();
            for t in self.original.iter().filter(|t| !t.detached) {
                if let Some(block) = t.block {
                    self.album.entry(block).or_default().push(t.id);
                }
            }
        }

        fn step(&mut self) {
            match self.rng.below(8) {
                0 if !self.shuffle => {
                    self.shuffle = true;
                    self.shuffle_from(self.index);
                }
                1 if self.shuffle => {
                    // An order is rebuilt: the cursor finds the playing copy by identity. Only a
                    // loose copy can be one of several, and then the first is taken.
                    self.shuffle = false;
                    self.queue = self.original.clone();
                    self.index = reseat_index(&self.queue, self.anchor, self.index);
                    if self.anchor.is_some_and(|(_, block)| block.is_none()) {
                        self.playing = self.queue.get(self.index).map(|t| t.path.clone());
                    }
                }
                2 => {
                    self.queue = self.batch();
                    self.original = self.queue.clone();
                    let members: Vec<usize> = (0..self.queue.len())
                        .filter(|&i| self.queue[i].block.is_some())
                        .collect();
                    let start = match members.len() {
                        0 => self.rng.below(self.queue.len()),
                        n => members[self.rng.below(n)],
                    };
                    self.seat(start);
                    if self.shuffle {
                        self.shuffle_from(start);
                    }
                }
                3 => {
                    let tracks = self.batch();
                    let at = insert_after_current(
                        &mut self.queue,
                        &mut self.original,
                        self.shuffle,
                        self.index,
                        self.anchor,
                        tracks,
                    );
                    if self.anchor.is_none() {
                        self.seat(at);
                    }
                }
                4 => {
                    let tracks = self.batch();
                    let first = enqueue_tracks(&mut self.queue, &mut self.original, tracks);
                    if self.anchor.is_none() {
                        self.seat(first);
                    }
                }
                5 if !self.queue.is_empty() => {
                    let from = self.rng.below(self.queue.len());
                    let to = self.rng.below(self.queue.len() + 1);
                    if let Some(dest) =
                        move_queue_item(&mut self.queue, &mut self.original, self.shuffle, from, to)
                    {
                        self.index = clamp_index(
                            index_after_move(self.index, from, dest),
                            self.queue.len(),
                        );
                        if !self.shuffle {
                            self.rebaseline_albums();
                        }
                    }
                }
                6 if !self.queue.is_empty() => {
                    let i = self.rng.below(self.queue.len());
                    remove_queue_item(&mut self.queue, &mut self.original, self.shuffle, i);
                    if i == self.index {
                        let next = clamp_index(i, self.queue.len());
                        self.seat(next);
                    } else {
                        self.index = index_after_remove(self.index, i, self.queue.len());
                    }
                }
                7 => {
                    self.queue = self.batch();
                    self.original = self.queue.clone();
                    self.shuffle = false;
                    let i = self.rng.below(self.queue.len());
                    self.seat(i);
                }
                _ => {}
            }
        }

        fn check(&self, at: &str) {
            for order in [&self.queue, &self.original] {
                let mut rows: HashMap<u64, Vec<(usize, i64)>> = HashMap::new();
                for (i, t) in order.iter().enumerate() {
                    if let Some(block) = t.block {
                        rows.entry(block).or_default().push((i, t.id));
                    }
                }
                for (block, rows) in &rows {
                    let mut seen = std::collections::HashSet::new();
                    assert!(
                        rows.iter().all(|(_, id)| seen.insert(*id)),
                        "{at}: token {block} names two blocks"
                    );
                }
                let mut attached: HashMap<u64, Vec<usize>> = HashMap::new();
                for (i, t) in order.iter().enumerate() {
                    if let Some(block) = member_of(t) {
                        attached.entry(block).or_default().push(i);
                    }
                }
                for (block, slots) in &attached {
                    assert!(
                        slots.windows(2).all(|w| w[1] == w[0] + 1),
                        "{at}: block {block} is split"
                    );
                }
            }
            for (block, album) in &self.album {
                let members: Vec<i64> = self
                    .original
                    .iter()
                    .filter(|t| member_of(t) == Some(*block))
                    .map(|t| t.id)
                    .collect();
                let mut rest = album.iter();
                assert!(
                    members.iter().all(|id| rest.any(|a| a == id)),
                    "{at}: block {block} left album order"
                );
            }
            let flags = |order: &[QueueTrack]| -> Vec<(i64, Option<u64>, bool)> {
                order.iter().map(|t| (t.id, t.block, t.detached)).collect()
            };
            if !self.shuffle {
                assert_eq!(flags(&self.queue), flags(&self.original), "{at}");
            }
            let (mut a, mut b) = (copies(&self.queue), copies(&self.original));
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b, "{at}: the orders hold different copies");
            if let Some(anchor) = self.anchor {
                let under = self.queue.get(self.index);
                assert_eq!(under.map(|t| (t.id, t.block)), Some(anchor), "{at}: the cursor left the copy");
                assert_eq!(under.map(|t| t.path.clone()), self.playing, "{at}: the cursor left the row");
            }
        }
    }

    #[test]
    fn blocks_stay_whole_through_random_edits() {
        for seed in 0..200 {
            let mut model = Model {
                queue: Vec::new(),
                original: Vec::new(),
                shuffle: false,
                index: 0,
                anchor: None,
                playing: None,
                next: 0,
                serial: 0,
                rng: Xorshift::new(seed),
                album: HashMap::new(),
            };
            for step in 0..60 {
                model.step();
                model.check(&format!("seed {seed} step {step}"));
            }
        }
    }
}
