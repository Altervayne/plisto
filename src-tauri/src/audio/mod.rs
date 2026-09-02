/*
 * The shared, framework-free audio core. Two consumers lean on it at two drain rates: the realtime
 * player pulls packets incrementally as it plays, and the splicer drains a whole file to compute
 * waveform peaks and silence spans. Only `decode` touches symphonia; `peaks` and `silence` are pure
 * functions over interleaved f32 PCM, so they test on synthetic buffers with no decoder and no device.
 */

// The realtime player engine and the splicer commands are the callers of this core; neither is wired
// into the crate yet, so its public surface and convenience re-exports have no in-crate use. Allow it
// across the module rather than mark each item, and drop this once a consumer lands.
#![allow(dead_code, unused_imports)]

// -- Library Imports --
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// -- Module Declarations --
pub mod decode;
pub mod engine;
pub mod flac_frames;
pub mod peaks;
pub mod silence;
pub mod spectrum;

// -- Re-exports --
pub use decode::{DecodeError, Decoder};
pub use peaks::{compute_peaks, Peak, PeakAccumulator};
pub use silence::{find_silence, SilenceDetector, SilenceSpan};

// The player's shared vocabulary: the command layer speaks these, the engine thread consumes them,
// and the frontend reads the status snapshot back. Defined here beside the audio core so both the
// engine and the IPC surface pull from one place.

/// How the queue behaves at the end of a track: play once through, loop the whole queue, or repeat
/// the current track forever. Serialized lowercase so the frontend reads `"off"`/`"all"`/`"one"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    One,
}

/// One entry in the play queue: the track id the frontend keys on, plus its resolved file path. The
/// command layer resolves ids to paths so the engine stays DB-free and never touches a connection.
/// Cloned only when the queue is (re)built - on a Play or a shuffle toggle - never per tick.
#[derive(Clone)]
pub struct QueueTrack {
    pub id: i64,
    pub path: PathBuf,
}

/// A transport instruction sent to the resident engine thread over the command channel. The engine
/// owns all playback state; these are the only way to move it.
pub enum PlayerCmd {
    Play { queue: Vec<QueueTrack>, index: usize },
    TogglePlay,
    Pause,
    Resume,
    Stop,
    Next,
    Prev,
    // Jumps the cursor straight to the queue slot at this index, like a click in the up-next list.
    // Clamped to the last slot; landing on a dead track skips forward to the next playable one.
    Jump(usize),
    // Appends tracks to the end of the queue. New tracks land last in up-next whether shuffled or
    // not; the live source plays on across the append.
    Enqueue(Vec<QueueTrack>),
    // Moves the queue item at `from` to `to`, reindexing the rest. Never touches the sink; the
    // current track keeps playing under a new cursor.
    MoveQueueItem { from: usize, to: usize },
    // Removes the queue item at `index`. Removing an up-next track leaves playback alone; removing
    // the current track skips to whatever slid into its slot.
    RemoveQueueItem { index: usize },
    Seek(f64),
    SetVolume(f32),
    SetRepeat(RepeatMode),
    // Materializes a shuffled queue order (true) or restores the original insertion order (false),
    // keeping the current track playing across the toggle.
    SetShuffle(bool),
    // None follows the system default output; Some(name) pins that named device.
    SetOutputDevice(Option<String>),
    // A transient audition of `path` between two seconds, stopped at the out-point. It plays on the
    // resident sink but leaves the queue and cursor untouched, so library playback restores after.
    Preview {
        path: PathBuf,
        start_secs: f64,
        end_secs: f64,
    },
    // Reopens the current queue track at `secs` and reseats it as the library source, setting the
    // paused state from `playing`. A preview clears the sink, so a bare resume would play silence;
    // this restores the exact track and play head instead. A no-op with an empty queue.
    RestoreLibrary {
        secs: f64,
        playing: bool,
    },
}

/// One selectable output device, for the settings picker. `is_default` marks the current OS default
/// so the UI can badge it. Named devices are pinned by `name`; the picker's "System default" entry
/// carries no name and maps to `SetOutputDevice(None)`.
#[derive(Clone, Debug, Serialize)]
pub struct OutputDeviceInfo {
    pub name: String,
    pub is_default: bool,
}

/// The app-global playback snapshot: what the engine is doing right now. Written every engine tick
/// and mirrored into shared state, so `get_player_status` reads it without waiting on an event.
#[derive(Clone, Debug, Serialize)]
pub struct PlayerStatus {
    pub playing: bool,
    pub track_id: Option<i64>,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,
    pub repeat: RepeatMode,
    pub queue_index: usize,
    pub queue_len: usize,
    // Whether the queue is playing in a shuffled order. The order itself lives in the engine's queue
    // and the separate `player:queue` mirror; this is only the toggle state for the UI.
    pub shuffle: bool,
    // The name of the device actually rendering, or None while output is following the system
    // default before a device is resolved / when no device is open.
    pub output_device: Option<String>,
}

impl Default for PlayerStatus {
    fn default() -> Self {
        Self {
            playing: false,
            track_id: None,
            position_secs: 0.0,
            duration_secs: 0.0,
            volume: 1.0,
            repeat: RepeatMode::Off,
            queue_index: 0,
            queue_len: 0,
            shuffle: false,
            output_device: None,
        }
    }
}

/// The sample format of a decoded stream: the rate in Hz and the interleaved channel count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioSpec {
    pub sample_rate: u32,
    pub channels: u16,
}

/// One decoded block: interleaved f32 samples in [-1.0, 1.0] and the spec they carry. Interleaved
/// means frame N occupies `samples[N * channels .. (N + 1) * channels]`.
#[derive(Clone, Debug)]
pub struct PcmChunk {
    pub samples: Vec<f32>,
    pub spec: AudioSpec,
}

impl PcmChunk {
    /// The number of frames in this chunk: one frame is one sample per channel. Zero channels reads
    /// as zero frames rather than dividing by zero.
    pub fn frames(&self) -> usize {
        self.samples
            .len()
            .checked_div(self.spec.channels as usize)
            .unwrap_or(0)
    }
}

/// Collapses interleaved samples to one mono track by averaging each frame's channels. The shared
/// downmix behind both analysis passes, so a stereo file's peaks and silence read the same signal.
/// Zero channels or empty input yields an empty track.
pub(crate) fn downmix_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels as usize;
    if channels == 0 || samples.is_empty() {
        return Vec::new();
    }
    if channels == 1 {
        return samples.to_vec();
    }
    let frames = samples.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let base = frame * channels;
        let sum: f32 = samples[base..base + channels].iter().sum();
        mono.push(sum / channels as f32);
    }
    mono
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_divides_samples_by_channels() {
        let chunk = PcmChunk {
            samples: vec![0.0; 8],
            spec: AudioSpec {
                sample_rate: 44_100,
                channels: 2,
            },
        };
        assert_eq!(chunk.frames(), 4);
    }

    #[test]
    fn frames_with_zero_channels_is_zero() {
        let chunk = PcmChunk {
            samples: vec![0.0; 8],
            spec: AudioSpec {
                sample_rate: 44_100,
                channels: 0,
            },
        };
        assert_eq!(chunk.frames(), 0);
    }

    #[test]
    fn downmix_averages_stereo_frames() {
        // Two frames of L/R: (1.0, -1.0) averages to 0.0, (0.5, 0.5) stays 0.5.
        let mono = downmix_mono(&[1.0, -1.0, 0.5, 0.5], 2);
        assert_eq!(mono, vec![0.0, 0.5]);
    }

    #[test]
    fn downmix_mono_passes_through() {
        let mono = downmix_mono(&[0.1, 0.2, 0.3], 1);
        assert_eq!(mono, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn downmix_empty_or_zero_channels_is_empty() {
        assert!(downmix_mono(&[], 2).is_empty());
        assert!(downmix_mono(&[1.0, 2.0], 0).is_empty());
    }
}
