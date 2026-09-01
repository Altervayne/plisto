/*
 * The IPC command surface for the splicer/cropper. splice_run mirrors export_library: a running
 * guard, a reset cancel flag, a Preparing tick, a destination validated under a brief root read, then
 * a blocking worker awaited so the runtime stays free to service splice_cancel. The segments share
 * one source, so the worker cuts them sequentially and streams throttled progress. splice_analyze and
 * splice_detect_silence run their decode passes on blocking threads; splice_parse_cue is a pure read.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use crate::audio::SilenceSpan;
use crate::db;
use crate::dto::{
    AnalyzeProgress, CueSheet, SpliceJob, SplicePhase, SpliceProgress, SpliceReport,
    WaveformAnalysis,
};
use crate::export;
use crate::scan::progress::ProgressThrottle;
use crate::splice;
use crate::state::AppState;

// The progress emit cadence, matched to the scan and export: one tick at most per interval.
const PROGRESS_INTERVAL_MS: u64 = 100;

/// Cuts `job.segments` out of the source into `job.destination`, streaming progress over
/// `on_progress` and returning the report. Rejects while another splice runs. Reads the roots under a
/// brief lock, then validates the destination (refusing one inside a library folder or not writable)
/// and refuses any segment whose output path would land on the source file. Only WAV sources cut in
/// this build; other formats are refused with a clear message. The worker runs on a blocking thread
/// and is awaited, so splice_cancel stays serviceable.
#[tauri::command]
pub async fn splice_run(
    job: SpliceJob,
    on_progress: Channel<SpliceProgress>,
    state: State<'_, AppState>,
) -> Result<SpliceReport, String> {
    if state.splice_running.swap(true, Ordering::SeqCst) {
        return Err("a splice is already running".to_string());
    }
    state.splice_cancel.store(false, Ordering::SeqCst);

    let total = job.segments.len() as u32;
    let _ = on_progress.send(SpliceProgress {
        phase: SplicePhase::Preparing,
        completed: 0,
        total,
        errors: 0,
        done: false,
    });

    // Read every root path under one lock, then drop it: the worker is DB-free.
    let roots = {
        let read = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())
            .and_then(|conn| db::all_root_paths(&conn).map_err(|e| e.to_string()));
        match read {
            Ok(r) => r,
            Err(e) => {
                state.splice_running.store(false, Ordering::SeqCst);
                return Err(e);
            }
        }
    };

    let source = PathBuf::from(&job.source_path);
    let destination = PathBuf::from(&job.destination);

    // Refuse a destination inside any root or one that is not writable, before any write.
    let check = export::check_destination(&job.destination, &roots);
    if check.inside_workspace {
        state.splice_running.store(false, Ordering::SeqCst);
        return Err("the destination is inside a library folder".to_string());
    }
    if !check.writable {
        state.splice_running.store(false, Ordering::SeqCst);
        return Err("the destination is not writable".to_string());
    }

    // Only WAV cuts here; other recognized formats are deferred, an unknown extension is refused.
    let format = match splice::Format::from_source(&source) {
        Some(splice::Format::Wav) => splice::Format::Wav,
        Some(_) => {
            state.splice_running.store(false, Ordering::SeqCst);
            return Err("only WAV files can be split right now".to_string());
        }
        None => {
            state.splice_running.store(false, Ordering::SeqCst);
            return Err("this audio format is not supported".to_string());
        }
    };
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav")
        .to_string();

    // The source is read-only: refuse a job where any segment's output would land on it.
    let source_canon = source.canonicalize().unwrap_or_else(|_| source.clone());
    for (i, segment) in job.segments.iter().enumerate() {
        let stem = splice::segment_stem(&job.naming_pattern, segment, i);
        let out = destination.join(format!("{stem}.{ext}"));
        let out_canon = out.canonicalize().unwrap_or(out);
        if out_canon == source_canon {
            state.splice_running.store(false, Ordering::SeqCst);
            return Err("a segment would overwrite the source file".to_string());
        }
    }

    let cancel = Arc::clone(&state.splice_cancel);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL_MS);
        let start = Instant::now();
        let report = splice::run_splice(
            &source,
            format,
            &job.segments,
            &destination,
            &job.naming_pattern,
            job.collision,
            &ext,
            &cancel,
            |completed, errors| {
                let now = start.elapsed().as_millis() as u64;
                if throttle.should_emit(now, false) {
                    let _ = on_progress.send(SpliceProgress {
                        phase: SplicePhase::Cutting,
                        completed,
                        total,
                        errors,
                        done: false,
                    });
                }
            },
        );
        // The single terminal tick, once the worker is done.
        let _ = on_progress.send(SpliceProgress {
            phase: SplicePhase::Done,
            completed: report.items.len() as u32,
            total,
            errors: report.errors,
            done: true,
        });
        report
    })
    .await;

    state.splice_running.store(false, Ordering::SeqCst);
    match outcome {
        Ok(report) => Ok(report),
        Err(_) => Err("splice task failed to run".to_string()),
    }
}

/// Signals a running splice to stop. The worker finishes the segment it is on, skips the rest, and
/// reports the run as cancelled. Every segment already written stays valid.
#[tauri::command]
pub fn splice_cancel(state: State<'_, AppState>) -> Result<(), String> {
    state.splice_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Analyzes the file at `path` into `buckets` waveform peaks and its silence spans, streaming decode
/// progress over `on_progress`. Runs the single decode pass on a blocking thread.
#[tauri::command]
pub async fn splice_analyze(
    path: String,
    buckets: usize,
    threshold_db: f32,
    min_silence_secs: f64,
    on_progress: Channel<AnalyzeProgress>,
) -> Result<WaveformAnalysis, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL_MS);
        let start = Instant::now();
        splice::analyze_file(
            Path::new(&path),
            buckets,
            threshold_db,
            min_silence_secs,
            |done, total| {
                let now = start.elapsed().as_millis() as u64;
                let terminal = total > 0 && done >= total;
                if throttle.should_emit(now, terminal) {
                    let _ = on_progress.send(AnalyzeProgress {
                        done_frames: done,
                        total_frames: total,
                    });
                }
            },
        )
        .map_err(|e| e.to_string())
    })
    .await;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("analysis task failed to run".to_string()),
    }
}

/// Re-runs silence detection over the file at `path` with a fresh threshold and minimum length,
/// returning just the spans. Skips the waveform work, so a re-threshold is cheaper than a full
/// analysis. Runs on a blocking thread.
#[tauri::command]
pub async fn splice_detect_silence(
    path: String,
    threshold_db: f32,
    min_silence_secs: f64,
) -> Result<Vec<SilenceSpan>, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        splice::detect_silence(Path::new(&path), threshold_db, min_silence_secs)
            .map_err(|e| e.to_string())
    })
    .await;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("silence detection task failed to run".to_string()),
    }
}

/// Parses the cue sheet at `path` into its disc performer and tracks. A pure read; never touches the
/// index or the audio.
#[tauri::command]
pub fn splice_parse_cue(path: String) -> Result<CueSheet, String> {
    splice::parse_cue(Path::new(&path)).map_err(|e| e.to_string())
}
