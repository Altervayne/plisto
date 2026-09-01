/*
 * The audio splicer/cropper backend: analyze a file into a drawable waveform and silence spans,
 * define frame-range segments, and cut each one losslessly into a tagged file. This module owns the
 * cut dispatch and the sequential job that runs a whole segment list, mirroring the export pipeline's
 * shape - temp-then-rename per file, a cooperative cancel that keeps whatever landed, a per-item
 * report. The cutters themselves are format-specific; WAV, FLAC, and MP3 are wired here. WAV and FLAC
 * copy their samples bit-exact; MP3 copies whole frames, frame-aligned.
 */

// -- Module Declarations --
mod analyze;
mod cue;
mod flac;
mod mp3;
mod wav;

// -- Library Imports --
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

// -- Local Imports --
use crate::dto::{CollisionPolicy, Segment, SpliceItem, SpliceItemStatus, SpliceReport};
use crate::export::safe_component;
use crate::tags;

// -- Re-exports --
pub use analyze::{analyze_file, detect_silence};
pub use cue::parse_cue;

// The report note left on a segment that was skipped or could not land.
const NOTE_EXISTS: &str = "a file with this name already exists";
const NOTE_CUT_FAILED: &str = "the segment could not be cut";
const NOTE_TAGS_FAILED: &str = "the file was written but its tags could not be";

/// The source container a cut reads from, chosen by the source extension. WAV, FLAC, and MP3 cut here,
/// each without a re-encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Wav,
    Flac,
    Mp3,
}

impl Format {
    /// The format for a source path by its extension, or None when the extension names no audio
    /// container this backend knows.
    pub fn from_source(path: &Path) -> Option<Format> {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref()
        {
            Some("wav") => Some(Format::Wav),
            Some("flac") => Some(Format::Flac),
            Some("mp3") => Some(Format::Mp3),
            _ => None,
        }
    }
}

/// Why a segment could not be cut. `UnsupportedFormat` is a recognized container whose cutter is not
/// built; `Open` is a read/write failure; `Parse` is a malformed source container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutError {
    // Every format the extension resolver returns cuts today; this is held for a container that decodes
    // but has no cutter (M4A/AAC/Opus), so it is not yet constructed outside tests.
    #[allow(dead_code)]
    UnsupportedFormat,
    Open,
    Parse,
}

impl std::fmt::Display for CutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            CutError::UnsupportedFormat => "this audio format cannot be cut yet",
            CutError::Open => "could not read the source or write the segment",
            CutError::Parse => "the source file is not a valid audio container",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for CutError {}

/// Cuts one segment's frame range out of `source` into `out_tmp`, dispatching on the format. WAV and
/// FLAC copy samples bit-exact; MP3 copies whole frames, frame-aligned.
pub fn cut_segment(
    source: &Path,
    format: Format,
    segment: &Segment,
    out_tmp: &Path,
) -> Result<(), CutError> {
    match format {
        Format::Wav => wav::cut(source, segment.start_frame, segment.end_frame, out_tmp),
        Format::Flac => flac::cut(source, segment.start_frame, segment.end_frame, out_tmp),
        Format::Mp3 => mp3::cut(source, segment.start_frame, segment.end_frame, out_tmp),
    }
}

/// Runs the whole segment list against `source` in order, writing each cut into `destination` under
/// the naming pattern and collision policy, and returns the report. Segments share one source so they
/// run sequentially. Each lands through a temp-then-rename so a cancel or failure never leaves a torn
/// file. `cancel` stops the run before the next segment, keeping every segment already written;
/// `emit(completed, errors)` is called after each segment for a progress read. The source is only
/// read; nothing is written outside `destination`.
#[allow(clippy::too_many_arguments)]
pub fn run_splice<E>(
    source: &Path,
    format: Format,
    segments: &[Segment],
    destination: &Path,
    naming_pattern: &str,
    collision: CollisionPolicy,
    ext: &str,
    keep_source_tags: bool,
    cancel: &AtomicBool,
    mut emit: E,
) -> SpliceReport
where
    E: FnMut(u32, u32),
{
    let total = segments.len() as u32;
    let mut items: Vec<SpliceItem> = Vec::new();
    let mut written = 0u32;
    let mut errors = 0u32;
    let mut cancelled = false;

    for (i, segment) in segments.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let index = i as u32;
        let stem = segment_stem(naming_pattern, segment, i);
        let final_name = format!("{stem}.{ext}");
        let tmp = destination.join(format!(".plisto-tmp-{final_name}"));

        match cut_segment(source, format, segment, &tmp) {
            Ok(()) => {
                let tag_note = tag_segment(source, &tmp, segment, i, keep_source_tags);
                match resolve_collision(destination, &stem, ext, collision) {
                    Some(final_path) => match fs::rename(&tmp, &final_path) {
                        Ok(()) => {
                            written += 1;
                            items.push(SpliceItem {
                                index,
                                output_path: Some(path_string(&final_path)),
                                status: SpliceItemStatus::Written,
                                note: tag_note,
                            });
                        }
                        Err(_) => {
                            let _ = fs::remove_file(&tmp);
                            errors += 1;
                            items.push(SpliceItem {
                                index,
                                output_path: None,
                                status: SpliceItemStatus::Failed,
                                note: Some(NOTE_CUT_FAILED.to_string()),
                            });
                        }
                    },
                    None => {
                        let _ = fs::remove_file(&tmp);
                        items.push(SpliceItem {
                            index,
                            output_path: None,
                            status: SpliceItemStatus::Skipped,
                            note: Some(NOTE_EXISTS.to_string()),
                        });
                    }
                }
            }
            Err(_) => {
                let _ = fs::remove_file(&tmp);
                errors += 1;
                items.push(SpliceItem {
                    index,
                    output_path: None,
                    status: SpliceItemStatus::Failed,
                    note: Some(NOTE_CUT_FAILED.to_string()),
                });
            }
        }

        emit(i as u32 + 1, errors);
    }

    SpliceReport {
        total,
        written,
        errors,
        cancelled,
        items,
    }
}

/// The sanitized filename stem for one segment, filling the naming pattern's tokens and falling back
/// to `Track N` when the result is empty. The extension is appended by the caller.
pub fn segment_stem(pattern: &str, segment: &Segment, index: usize) -> String {
    let number = segment.track_no.unwrap_or(index as i64 + 1);
    let raw = pattern
        .replace("{track_no}", &format!("{number:02}"))
        .replace("{title}", segment.title.as_deref().unwrap_or(""))
        .replace("{artist}", segment.artist.as_deref().unwrap_or(""));
    safe_component(&raw, &format!("Track {}", index + 1))
}

/// Tags the freshly cut file at `output` from the source's own tag. Both verbs first carry the whole
/// source tag across (cover included) so the cut keeps album, album_artist, year, genre and disc. The
/// splitter then overlays each segment's per-track title, artist and number; the cropper keeps the
/// source tag verbatim, the trimmed file being the same track. Best effort: the audio is already valid,
/// so a tag failure leaves a note rather than failing the write.
fn tag_segment(
    source: &Path,
    output: &Path,
    segment: &Segment,
    index: usize,
    keep_source_tags: bool,
) -> Option<String> {
    if tags::copy_tags(source, output).is_err() {
        return Some(NOTE_TAGS_FAILED.to_string());
    }
    if keep_source_tags {
        return None;
    }
    let track_no = segment.track_no.unwrap_or((index + 1) as i64);
    match tags::retag_split_segment(output, segment.title.as_deref(), segment.artist.as_deref(), track_no)
    {
        Ok(()) => None,
        Err(_) => Some(NOTE_TAGS_FAILED.to_string()),
    }
}

/// Resolves the final path for a cut under the collision policy: Overwrite always writes the base
/// name, Skip returns None when it exists, Rename finds the first free ` (n)` suffix. Returns the
/// path to rename the temp onto, or None to skip.
fn resolve_collision(
    destination: &Path,
    stem: &str,
    ext: &str,
    collision: CollisionPolicy,
) -> Option<std::path::PathBuf> {
    let base = destination.join(format!("{stem}.{ext}"));
    match collision {
        CollisionPolicy::Overwrite => Some(base),
        CollisionPolicy::Skip => {
            if base.exists() {
                None
            } else {
                Some(base)
            }
        }
        CollisionPolicy::Rename => {
            if !base.exists() {
                return Some(base);
            }
            for n in 1..=9_999 {
                let candidate = destination.join(format!("{stem} ({n}).{ext}"));
                if !candidate.exists() {
                    return Some(candidate);
                }
            }
            // Every suffix is taken; overwrite the base rather than dropping the segment silently.
            Some(base)
        }
    }
}

/// A path as a display string with forward slashes, for the report the done screen reads.
fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plisto_splice_{}_{n}_{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A canonical mono 16-bit PCM WAV of `frames` ramp samples, the source the job cuts.
    fn write_wav(path: &Path, frames: usize) {
        let rate = 44_100u32;
        let channels = 1u16;
        let bits = 16u16;
        let block_align = channels * bits / 8;
        let data_len = (frames * channels as usize * (bits / 8) as usize) as u32;

        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * block_align as u32).to_le_bytes());
        v.extend_from_slice(&block_align.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for frame in 0..frames {
            let sample = ((frame % 200) as i32 - 100) as i16 * 300;
            v.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(path, v).unwrap();
    }

    fn segment(start: u64, end: u64, title: &str, track_no: i64) -> Segment {
        Segment {
            start_frame: start,
            end_frame: end,
            title: Some(title.to_string()),
            artist: Some("Artist".to_string()),
            track_no: Some(track_no),
        }
    }

    #[test]
    fn runs_two_segments_into_two_valid_outputs() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        let dest = dir.path.join("out");
        fs::create_dir_all(&dest).unwrap();
        write_wav(&source, 4_000);

        let segments = vec![
            segment(0, 1_000, "First", 1),
            segment(1_000, 2_500, "Second", 2),
        ];
        let cancel = AtomicBool::new(false);
        let mut ticks = 0;
        let report = run_splice(
            &source,
            Format::Wav,
            &segments,
            &dest,
            "{track_no} - {title}",
            CollisionPolicy::Rename,
            "wav",
            false,
            &cancel,
            |_, _| ticks += 1,
        );

        assert_eq!(report.total, 2);
        assert_eq!(report.written, 2);
        assert_eq!(report.errors, 0);
        assert!(!report.cancelled);
        assert_eq!(ticks, 2, "one progress tick per segment");

        // Both files land under their sanitized names and reopen as valid WAVs.
        let first = dest.join("01 - First.wav");
        let second = dest.join("02 - Second.wav");
        assert!(first.exists() && second.exists());
        let d1 = crate::audio::Decoder::open(&first).expect("first opens");
        assert_eq!(d1.total_frames(), Some(1_000));
        let d2 = crate::audio::Decoder::open(&second).expect("second opens");
        assert_eq!(d2.total_frames(), Some(1_500));

        // No temp files are left behind.
        let temps = fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".plisto-tmp-"))
            .count();
        assert_eq!(temps, 0, "temps are renamed or cleaned");
    }

    #[test]
    fn cancel_keeps_the_segments_already_written() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        let dest = dir.path.join("out");
        fs::create_dir_all(&dest).unwrap();
        write_wav(&source, 4_000);

        let segments = vec![
            segment(0, 500, "First", 1),
            segment(500, 1_000, "Second", 2),
        ];
        // Trip the cancel after the first segment's tick.
        let cancel = AtomicBool::new(false);
        let report = run_splice(
            &source,
            Format::Wav,
            &segments,
            &dest,
            "{track_no} - {title}",
            CollisionPolicy::Rename,
            "wav",
            false,
            &cancel,
            |completed, _| {
                if completed == 1 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );

        assert_eq!(report.total, 2);
        assert_eq!(report.written, 1, "only the first segment landed");
        assert!(report.cancelled);
        assert!(dest.join("01 - First.wav").exists());
        assert!(!dest.join("02 - Second.wav").exists());
    }

    #[test]
    fn skip_policy_leaves_an_existing_file_untouched() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        let dest = dir.path.join("out");
        fs::create_dir_all(&dest).unwrap();
        write_wav(&source, 2_000);

        // Pre-place a file at the segment's target name.
        let existing = dest.join("01 - First.wav");
        fs::write(&existing, b"keep me").unwrap();

        let segments = vec![segment(0, 500, "First", 1)];
        let cancel = AtomicBool::new(false);
        let report = run_splice(
            &source,
            Format::Wav,
            &segments,
            &dest,
            "{track_no} - {title}",
            CollisionPolicy::Skip,
            "wav",
            false,
            &cancel,
            |_, _| {},
        );

        assert_eq!(report.written, 0);
        assert_eq!(report.items[0].status, SpliceItemStatus::Skipped);
        assert_eq!(
            fs::read(&existing).unwrap(),
            b"keep me",
            "the existing file is untouched"
        );
    }

    #[test]
    fn an_mp3_source_dispatches_to_the_mp3_cutter() {
        // MP3 cuts now, so a garbage source reaches the cutter and reads as a parse failure rather than
        // the unsupported-format refusal.
        let dir = TempDir::new();
        let source = dir.path.join("in.mp3");
        let out = dir.path.join("x.mp3");
        fs::write(&source, b"no mp3 sync anywhere in here").unwrap();
        let seg = segment(0, 10, "X", 1);
        assert_eq!(
            cut_segment(&source, Format::Mp3, &seg, &out),
            Err(CutError::Parse),
        );
    }
}
