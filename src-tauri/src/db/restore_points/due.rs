/*
 * When a point is due. Pure rules over the points already in the folder and the clock, so the
 * schedulers that call them hold no policy of their own.
 */

// -- Local Imports --
use super::list::{PointEntry, PointStatus};
use super::Reason;

/// How old the newest daily point must be before another is due: 24 hours, in ms.
pub const DAILY_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

/// Whether launching `running` after `last_run` calls for a version point. A key never written, or
/// written by another version, does.
pub fn version_point_due(last_run: Option<&str>, running: &str) -> bool {
    last_run != Some(running)
}

/// Whether the daily ring has no point, or its newest is at least a day older than `now_ms`. A newest
/// point stamped after `now_ms` (the clock ran ahead and was corrected) is due too.
pub fn daily_due(points: &[PointEntry], now_ms: i64) -> bool {
    let newest = points
        .iter()
        .filter(|p| p.reason == Reason::Daily)
        .map(|p| p.created_at)
        .max();
    newest.is_none_or(|at| now_ms < at || now_ms - at >= DAILY_INTERVAL_MS)
}

/// The content hash of the newest readable point of any ring.
pub fn newest_content_hash(points: &[PointEntry]) -> Option<&str> {
    points
        .iter()
        .filter_map(|p| match &p.status {
            PointStatus::Ready(meta) => Some((p.created_at, meta.content_hash.as_str())),
            _ => None,
        })
        .max_by_key(|(at, _)| *at)
        .map(|(_, hash)| hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::restore_points::PointMeta;

    fn entry(reason: Reason, created_at: i64, hash: Option<&str>) -> PointEntry {
        let status = match hash {
            Some(hash) => PointStatus::Ready(PointMeta {
                format: 1,
                app_version: "1.0.0".to_string(),
                schema_version: 22,
                created_at,
                reason: reason.as_str().to_string(),
                detail: None,
                albums: 1,
                singles: 0,
                playlists: 0,
                filed_tracks: 0,
                edited_tracks: 0,
                genre_tracks: 0,
                content_hash: hash.to_string(),
            }),
            None => PointStatus::Unreadable {
                error: "bad".to_string(),
            },
        };
        PointEntry {
            file: format!("rp-{created_at}-{}.sqlite", reason.as_str()),
            reason,
            created_at,
            bytes: 1,
            status,
        }
    }

    #[test]
    fn the_version_rule_covers_first_run_same_and_new() {
        assert!(version_point_due(None, "2.7.2"));
        assert!(!version_point_due(Some("2.7.2"), "2.7.2"));
        assert!(version_point_due(Some("2.7.1"), "2.7.2"));
    }

    #[test]
    fn a_daily_is_due_with_none_or_a_day_old_newest() {
        assert!(daily_due(&[], 5));
        let ring = [
            entry(Reason::Daily, 1_000, Some("a")),
            entry(Reason::Daily, 500, Some("b")),
        ];
        assert!(!daily_due(&ring, 1_000 + DAILY_INTERVAL_MS - 1));
        assert!(daily_due(&ring, 1_000 + DAILY_INTERVAL_MS));
    }

    #[test]
    fn a_daily_stamped_in_the_future_is_due() {
        let ring = [entry(Reason::Daily, 5_000_000, Some("a"))];
        assert!(daily_due(&ring, 1_000));
        assert!(!daily_due(&ring, 5_000_000));
    }

    #[test]
    fn only_daily_points_set_the_daily_age() {
        let ring = [entry(Reason::Action, 1_000, Some("a"))];
        assert!(daily_due(&ring, 1_001));
    }

    #[test]
    fn the_newest_readable_point_of_any_ring_supplies_the_hash() {
        let ring = [
            entry(Reason::Daily, 100, Some("old")),
            entry(Reason::Action, 300, Some("new")),
            entry(Reason::Version, 400, None),
        ];
        assert_eq!(newest_content_hash(&ring), Some("new"));
        assert_eq!(newest_content_hash(&[]), None);
    }
}
