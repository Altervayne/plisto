/*
 * The file analysis pass: open a decoder once and drain the whole stream through two streaming
 * accumulators in one go, yielding the waveform peaks and the silence spans the splicer draws and
 * seeds cuts from. Memory stays bounded to the buckets, one decoded chunk, and the spans found - the
 * samples are never collected. `detect_silence` is the lighter re-threshold pass that reruns only the
 * silence detector when the threshold or minimum length changes.
 */

// -- Library Imports --
use std::path::Path;

// -- Local Imports --
use crate::audio::{
    downmix_mono, DecodeError, Decoder, PeakAccumulator, SilenceDetector, SilenceSpan,
};
use crate::dto::WaveformAnalysis;

/// Analyzes the file at `path` in a single decode pass: the mono downmix of each chunk feeds both the
/// peak accumulator (into `buckets` peaks) and the silence detector (at `threshold_db` /
/// `min_silence_secs`). `tick` is called after each chunk with the frames done and the total, for a
/// throttled progress read. Fails only when the file cannot be opened or decoded.
pub fn analyze_file<F>(
    path: &Path,
    buckets: usize,
    threshold_db: f32,
    min_silence_secs: f64,
    mut tick: F,
) -> Result<WaveformAnalysis, DecodeError>
where
    F: FnMut(u64, u64),
{
    let mut decoder = Decoder::open(path)?;
    let spec = decoder.spec();
    let total = decoder.total_frames();
    let duration = decoder.duration_secs();

    let mut peaks = PeakAccumulator::new(buckets, total);
    let mut silence = SilenceDetector::new(spec, threshold_db, min_silence_secs);

    let total_hint = total.unwrap_or(0);
    let mut frames_done: u64 = 0;
    while let Some(chunk) = decoder.next_packet() {
        let mono = downmix_mono(&chunk.samples, chunk.spec.channels);
        for &v in &mono {
            peaks.push_mono(v);
            silence.push_mono(v);
        }
        frames_done += mono.len() as u64;
        tick(frames_done, total_hint);
    }

    let total_frames = total.unwrap_or(frames_done);
    let duration_secs = match duration {
        Some(d) => d,
        None if spec.sample_rate > 0 => total_frames as f64 / spec.sample_rate as f64,
        None => 0.0,
    };

    Ok(WaveformAnalysis {
        peaks: peaks.finish(),
        silence: silence.finish(),
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        total_frames,
        duration_secs,
    })
}

/// Re-runs silence detection over the file at `path` with a fresh threshold and minimum length,
/// decoding the stream but skipping the waveform work. Feeds the same streaming detector the full
/// analysis uses, so a re-threshold matches the original pass.
pub fn detect_silence(
    path: &Path,
    threshold_db: f32,
    min_silence_secs: f64,
) -> Result<Vec<SilenceSpan>, DecodeError> {
    let mut decoder = Decoder::open(path)?;
    let spec = decoder.spec();
    let mut silence = SilenceDetector::new(spec, threshold_db, min_silence_secs);
    while let Some(chunk) = decoder.next_packet() {
        let mono = downmix_mono(&chunk.samples, chunk.spec.channels);
        for &v in &mono {
            silence.push_mono(v);
        }
    }
    Ok(silence.finish())
}
