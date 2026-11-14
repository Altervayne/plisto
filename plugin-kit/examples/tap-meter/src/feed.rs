/*
 * What tap-meter makes of Plisto's playback feed and of the tap's segment records. A `feed` frame earns
 * log lines: what changed, how many events were lost, and the output device id when `audio.device` is
 * granted. The tap's records show the epoch rule as built: a cold start, a seek or a writer resuming
 * opens a new epoch, while a gapless successor or a format change writes a new record in the same one.
 */

// -- Library Imports --
use serde::Deserialize;

// -- Local Imports --
use crate::protocol::LogLevel;
use crate::tap::Segment;

/// The fields of a `feed` event this plugin reads. The event carries more; unknown fields are ignored.
#[derive(Debug, Default, Deserialize, PartialEq)]
pub struct FeedEvent {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub cause: String,
    #[serde(default)]
    pub tap_epoch: u64,
    #[serde(default)]
    pub transport: String,
    /// Null unless the plugin holds `audio.device`, and when no device is open.
    #[serde(default)]
    pub device_id: Option<String>,
}

/// The log lines for one `feed` frame. Volume changes are left out: a slider drag sends one per step.
pub fn feed_lines(event: &FeedEvent, lost: u64) -> Vec<(LogLevel, String)> {
    let mut lines = Vec::new();
    if lost > 0 {
        lines.push((
            LogLevel::Warn,
            format!("feed lost {lost} event(s) before seq {}", event.seq),
        ));
    }
    match event.cause.as_str() {
        "volume" => {}
        "snapshot" => lines.push((
            LogLevel::Info,
            format!(
                "feed snapshot: {}, tap epoch {}",
                event.transport, event.tap_epoch
            ),
        )),
        cause => lines.push((
            LogLevel::Info,
            format!(
                "feed {cause}: {}, tap epoch {} (seq {})",
                event.transport, event.tap_epoch, event.seq
            ),
        )),
    }
    if matches!(event.cause.as_str(), "snapshot" | "device") {
        let device = match &event.device_id {
            Some(id) => format!("output device id {id}"),
            None => "output device id unknown (none open, or audio.device not granted)".into(),
        };
        lines.push((LogLevel::Info, device));
    }
    lines
}

/// Follows the epoch of the tap records the reader reaches.
#[derive(Default)]
pub struct Epochs {
    current: Option<u32>,
}

impl Epochs {
    /// The log line for a record, and whether it opens a new epoch: a discontinuity, after which
    /// accumulated levels mean nothing.
    pub fn record(&mut self, s: &Segment) -> (bool, String) {
        if self.current == Some(s.epoch) {
            let line = format!(
                "epoch {} continues: new record at {} Hz, {} ch",
                s.epoch, s.rate, s.channels
            );
            return (false, line);
        }
        self.current = Some(s.epoch);
        let line = format!("new epoch {}: {} Hz, {} ch", s.epoch, s.rate, s.channels);
        (true, line)
    }

    /// Forgets the epoch, after an overrun resynced the reader.
    pub fn reset(&mut self) {
        self.current = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(json: serde_json::Value) -> FeedEvent {
        serde_json::from_value(json).unwrap()
    }

    fn texts(lines: &[(LogLevel, String)]) -> Vec<&str> {
        lines.iter().map(|(_, text)| text.as_str()).collect()
    }

    #[test]
    fn the_event_plisto_sends_decodes_with_its_extra_fields() {
        let e = event(json!({
            "seq": 12, "cause": "seek", "tap_epoch": 4, "tap_cursor": 900, "transport": "playing",
            "sample_rate": 48000, "channels": 2, "position_secs": 3.5, "volume": 0.8,
            "device": null, "device_id": null, "latency_ms": 10.0
        }));
        assert_eq!(e.seq, 12);
        assert_eq!(e.cause, "seek");
        assert_eq!(e.tap_epoch, 4);
        assert_eq!(e.transport, "playing");
        assert_eq!(e.device_id, None);
    }

    #[test]
    fn lost_is_reported_only_when_it_is_not_zero() {
        let e = event(json!({"seq": 7, "cause": "pause", "transport": "paused"}));
        assert!(feed_lines(&e, 0).iter().all(|(l, _)| *l != LogLevel::Warn));
        let lines = feed_lines(&e, 3);
        assert_eq!(
            lines[0],
            (LogLevel::Warn, "feed lost 3 event(s) before seq 7".into())
        );
    }

    #[test]
    fn a_snapshot_names_the_current_state_and_the_device_id() {
        let e = event(json!({
            "seq": 40, "cause": "snapshot", "tap_epoch": 2, "transport": "paused",
            "device": "Speakers", "device_id": "{0.0.0.00000000}.{abc}"
        }));
        assert_eq!(
            texts(&feed_lines(&e, 0)),
            [
                "feed snapshot: paused, tap epoch 2",
                "output device id {0.0.0.00000000}.{abc}"
            ]
        );
        let without = event(json!({"cause": "snapshot", "transport": "stopped"}));
        assert!(texts(&feed_lines(&without, 0))[1].starts_with("output device id unknown"));
    }

    #[test]
    fn seeks_and_starts_are_logged_and_volume_is_not() {
        let seek =
            event(json!({"seq": 5, "cause": "seek", "tap_epoch": 3, "transport": "playing"}));
        assert_eq!(
            texts(&feed_lines(&seek, 0)),
            ["feed seek: playing, tap epoch 3 (seq 5)"]
        );
        let volume = event(json!({"seq": 6, "cause": "volume", "transport": "playing"}));
        assert!(feed_lines(&volume, 0).is_empty());
    }

    fn segment(epoch: u32, rate: u32) -> Segment {
        Segment {
            start_cursor: 0,
            epoch,
            rate,
            channels: 2,
        }
    }

    #[test]
    fn a_new_epoch_is_a_discontinuity_and_a_record_in_the_same_one_is_not() {
        let mut epochs = Epochs::default();
        assert_eq!(
            epochs.record(&segment(1, 44_100)),
            (true, "new epoch 1: 44100 Hz, 2 ch".into())
        );
        // A gapless successor or a format change: same epoch, new record.
        assert_eq!(
            epochs.record(&segment(1, 48_000)),
            (
                false,
                "epoch 1 continues: new record at 48000 Hz, 2 ch".into()
            )
        );
        // A seek or a track change by a cold start.
        assert!(epochs.record(&segment(2, 48_000)).0);
        epochs.reset();
        assert!(epochs.record(&segment(2, 48_000)).0);
    }
}
