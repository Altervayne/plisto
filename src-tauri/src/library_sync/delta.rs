/*
 * The changed-row buffer behind `library:delta`. Ids gather as a session commits and flush at most
 * once per interval, plus a forced flush at session end. Past a cap the ids are dropped for a single
 * reload, which is cheaper for the frontend than fetching that many rows one by one. Pure: the clock
 * is passed in.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

// -- Local Imports --
use crate::dto::LibraryDelta;

/// The shortest gap between two delta flushes within a session.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(2);

/// Past this many pending ids a flush asks for a reload instead.
const MAX_IDS: usize = 5000;

pub struct DeltaBuffer {
    ids: BTreeSet<i64>,
    reload: bool,
    last_flush: Instant,
}

impl DeltaBuffer {
    /// An empty buffer whose first flush comes one interval after `now`.
    pub fn new(now: Instant) -> Self {
        Self {
            ids: BTreeSet::new(),
            reload: false,
            last_flush: now,
        }
    }

    pub fn add(&mut self, ids: impl IntoIterator<Item = i64>) {
        if self.reload {
            return;
        }
        self.ids.extend(ids);
        if self.ids.len() > MAX_IDS {
            self.reload = true;
            self.ids.clear();
        }
    }

    /// The pending delta when there is one and the interval has passed, or at once when `force`.
    pub fn take(&mut self, now: Instant, force: bool) -> Option<LibraryDelta> {
        if self.ids.is_empty() && !self.reload {
            return None;
        }
        if !force && now.saturating_duration_since(self.last_flush) < FLUSH_INTERVAL {
            return None;
        }
        self.last_flush = now;
        if std::mem::take(&mut self.reload) {
            return Some(LibraryDelta::Reload { reload: true });
        }
        let ids = std::mem::take(&mut self.ids).into_iter().collect();
        Some(LibraryDelta::Ids { ids })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_flush_once_the_interval_has_passed() {
        let t = Instant::now();
        let mut buf = DeltaBuffer::new(t);
        buf.add([3, 1, 3]);
        assert_eq!(buf.take(t + Duration::from_secs(1), false), None);
        assert_eq!(
            buf.take(t + FLUSH_INTERVAL, false),
            Some(LibraryDelta::Ids { ids: vec![1, 3] })
        );
        buf.add([7]);
        assert_eq!(buf.take(t + Duration::from_secs(3), false), None);
        assert_eq!(
            buf.take(t + Duration::from_secs(3), true),
            Some(LibraryDelta::Ids { ids: vec![7] }),
            "a forced flush ignores the interval",
        );
    }

    #[test]
    fn nothing_pending_flushes_nothing() {
        let t = Instant::now();
        let mut buf = DeltaBuffer::new(t);
        assert_eq!(buf.take(t + FLUSH_INTERVAL, true), None);
    }

    #[test]
    fn too_many_ids_become_a_reload() {
        let t = Instant::now();
        let mut buf = DeltaBuffer::new(t);
        buf.add(0..=MAX_IDS as i64);
        buf.add([1]);
        assert_eq!(
            buf.take(t, true),
            Some(LibraryDelta::Reload { reload: true })
        );
        assert_eq!(buf.take(t, true), None, "the reload resets the buffer");
    }
}
