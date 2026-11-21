/*
 * An offline dump of the engine's own analysis of an audio file, one JSON per track, for replaying real
 * music through the visualizer lab. The file opens through `open_source` on a flat DSP stage, the
 * source's tap fills as it plays, and `analyze` reads it at the engine's tick period, so the frames are
 * the ones `emit_spectrum` would send. The dump differs from live playback in three ways: ticks land on
 * an exact grid instead of timer jitter, the stage is flat with no EQ or levelling gain, and the tap
 * is read at the sample just decoded rather than behind the mixer buffer.
 *
 * Run it with PLISTO_DUMP_IN (a file or a folder) and PLISTO_DUMP_OUT (a folder) set:
 *   cargo test --manifest-path src-tauri/Cargo.toml dump_tracks -- --ignored --nocapture
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};

// -- Local Imports --
use super::{analyze, AUDIBLE_TICK};
use crate::audio::dsp::DspShared;
use crate::audio::source::{self, BAND_COUNT, FINE_BAND_COUNT};

const EXTENSIONS: [&str; 7] = ["mp3", "m4a", "opus", "ogg", "flac", "wav", "aac"];

// Rounds to 4 decimals, as an f64 so the JSON prints the short form.
fn round4(v: f32) -> f64 {
    (f64::from(v) * 1e4).round() / 1e4
}

fn rounded(values: &[f32]) -> Vec<f64> {
    values.iter().map(|&v| round4(v)).collect()
}

// The audio files at `input`: the file itself, or the audio files directly inside the folder.
fn tracks_in(input: &Path) -> Vec<PathBuf> {
    if input.is_file() {
        return vec![input.to_path_buf()];
    }
    let mut found: Vec<PathBuf> = fs::read_dir(input)
        .expect("reads the input folder")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        })
        .collect();
    found.sort();
    found
}

// The dump's name for a track: its file stem as lowercase ASCII words joined by hyphens.
fn dump_name(track: &Path) -> String {
    let stem = track.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
    let mut name = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c.to_ascii_lowercase());
        } else if !name.ends_with('-') && !name.is_empty() {
            name.push('-');
        }
    }
    name.trim_end_matches('-').to_string()
}

// Plays `track` through the engine's source and analyzes it every tick. None when it does not open.
fn dump(track: &Path) -> Option<Value> {
    let mut src = source::open_source(track, None, 0.0, &Arc::new(DspShared::default()), None)?;
    let rate = src.spec.sample_rate;
    let tick_secs = AUDIBLE_TICK.as_secs_f64();

    let mut bands: Vec<Vec<f64>> = Vec::new();
    let mut fine: Vec<Vec<f64>> = Vec::new();
    let (mut rms, mut peak, mut flux, mut rms_db) = (vec![], vec![], vec![], vec![]);
    let mut prev = [0.0f32; BAND_COUNT];

    'ticks: for k in 1u64.. {
        let target = (k as f64 * tick_secs * f64::from(rate)).round() as u64;
        while src.spectrum.written.load(Ordering::Relaxed) < target {
            if src.next().is_none() {
                break 'ticks;
            }
        }
        let Some(a) = analyze(&src.spectrum, rate, &prev, target as f64 / f64::from(rate)) else {
            continue;
        };
        prev.copy_from_slice(&a.bands);
        bands.push(rounded(&a.bands));
        fine.push(rounded(&a.bins.bands(FINE_BAND_COUNT)));
        rms.push(round4(a.frame.rms));
        peak.push(round4(a.frame.peak));
        flux.push(round4(a.frame.flux));
        rms_db.push(round4(a.frame.rms_db));
    }

    let duration = src.spectrum.written.load(Ordering::Relaxed) as f64 / f64::from(rate);
    Some(json!({
        "sampleRate": rate,
        "tickMs": AUDIBLE_TICK.as_millis() as u64,
        "tickRate": round4((1.0 / tick_secs) as f32),
        // Tick i is the frame emitted at (i + 1) * tickMs into the track.
        "durationSecs": round4(duration as f32),
        "ticks": bands.len(),
        "bands": bands,
        "fine": fine,
        "rms": rms,
        "peak": peak,
        "flux": flux,
        "rmsDb": rms_db,
    }))
}

#[test]
#[ignore = "writes dumps from PLISTO_DUMP_IN to PLISTO_DUMP_OUT"]
fn dump_tracks() {
    let (Some(input), Some(output)) = (
        std::env::var_os("PLISTO_DUMP_IN"),
        std::env::var_os("PLISTO_DUMP_OUT"),
    ) else {
        return;
    };
    let output = PathBuf::from(output);
    fs::create_dir_all(&output).expect("creates the output folder");
    for track in tracks_in(Path::new(&input)) {
        let name = dump_name(&track);
        match dump(&track) {
            Some(value) => {
                let path = output.join(format!("{name}.json"));
                fs::write(&path, value.to_string()).expect("writes the dump");
                println!("{name}: {} ticks", value["ticks"]);
            }
            None => println!("{name}: does not open through the engine's decode path"),
        }
    }
}
