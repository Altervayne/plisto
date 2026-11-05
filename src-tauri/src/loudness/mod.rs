/*
 * The loudness worker: one resident thread on its own connection that fills in what track levelling
 * needs. For a row whose tags were never examined it reads the ReplayGain tags; for a row with no tag
 * track gain it measures integrated loudness through the shared decoder. It runs only while levelling
 * is on, one file at a time, and pauses while the scan lock is held. It never takes that lock: every
 * write is a single row conditioned on the stats the visit started from, so a concurrent rescan wins.
 * A file that cannot be reached is left unstamped and is retried on the next sweep, which a kick after
 * each scan starts; only a file that opened is stamped, with a NULL value when it gave none.
 */

// -- Module Declarations --
pub mod queue;
mod r128;
pub mod writer;

// -- Library Imports --
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

// -- Local Imports --
use crate::audio::Decoder;
use crate::db;
use crate::scan::progress::ProgressThrottle;
use crate::scan::{file_stats, root_reachable};
use crate::state::AppState;
use queue::PendingRow;
use r128::Meter;
use writer::{Loudness, Stamp};

/// How often a paused worker checks whether the scan lock was released.
const SCAN_POLL: Duration = Duration::from_secs(1);

/// How long the worker waits before retrying after a database error.
const ERROR_BACKOFF: Duration = Duration::from_secs(30);

const PROGRESS_INTERVAL_MS: u64 = 1000;

/// A request to the worker.
pub enum LoudnessCmd {
    /// Levelling was turned on or off.
    SetEnabled(bool),
    /// A scan or batch write finished: sweep the queue again from the start.
    Kick,
}

/// Starts the worker, idle unless `enabled`.
pub fn spawn(app: AppHandle, rx: Receiver<LoudnessCmd>, enabled: bool) {
    let _ = std::thread::Builder::new()
        .name("loudness".to_string())
        .spawn(move || {
            let Ok(conn) = db::open_db(&app.state::<AppState>().db_path) else {
                return;
            };
            Worker::new(app, conn, enabled).run(&rx);
        });
}

/// How one visit ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Visit {
    /// Everything due for the row was written.
    Done,
    /// The file was unreachable, or it or its row moved: nothing written, retried on a later sweep.
    Left,
    /// Cut short by a command or a scan: nothing written, the row is visited again.
    Stopped,
}

struct Worker {
    app: AppHandle,
    conn: Connection,
    enabled: bool,
    /// The last row id this sweep is past.
    cursor: i64,
    /// Root reachability, probed once per sweep so an offline drive costs one check, not one per file.
    roots: HashMap<i64, bool>,
    throttle: ProgressThrottle,
    started: Instant,
    /// A row was visited since the queue last drained, so the drain owes a final progress tick.
    worked: bool,
}

impl Worker {
    fn new(app: AppHandle, conn: Connection, enabled: bool) -> Self {
        Worker {
            app,
            conn,
            enabled,
            cursor: 0,
            roots: HashMap::new(),
            throttle: ProgressThrottle::new(PROGRESS_INTERVAL_MS),
            started: Instant::now(),
            worked: false,
        }
    }

    fn run(mut self, rx: &Receiver<LoudnessCmd>) {
        loop {
            while let Ok(cmd) = rx.try_recv() {
                self.apply(cmd);
            }
            if !self.enabled {
                match rx.recv() {
                    Ok(cmd) => self.apply(cmd),
                    Err(_) => return,
                }
                continue;
            }
            if self.scan_running() {
                if !self.wait(rx, SCAN_POLL) {
                    return;
                }
                continue;
            }
            match queue::next_pending(&self.conn, self.cursor) {
                Ok(Some(row)) => {
                    match self.visit_row(rx, &row) {
                        Ok(Visit::Stopped) => {}
                        Ok(_) => self.cursor = row.id,
                        Err(_) => {
                            if !self.wait(rx, ERROR_BACKOFF) {
                                return;
                            }
                            continue;
                        }
                    }
                    self.worked = true;
                    self.emit_progress(false);
                }
                Ok(None) => {
                    if self.worked {
                        self.emit_progress(true);
                        self.worked = false;
                    }
                    match rx.recv() {
                        Ok(cmd) => self.apply(cmd),
                        Err(_) => return,
                    }
                }
                Err(_) => {
                    if !self.wait(rx, ERROR_BACKOFF) {
                        return;
                    }
                }
            }
        }
    }

    /// Visits one row unless its root is offline. Commands that arrive during the decode are held and
    /// applied after it; only one that leaves levelling off, or a scan starting, cuts the decode short.
    fn visit_row(
        &mut self,
        rx: &Receiver<LoudnessCmd>,
        row: &PendingRow,
    ) -> rusqlite::Result<Visit> {
        if !self.root_online(row.root_id) {
            return Ok(Visit::Left);
        }
        let held = RefCell::new(Vec::new());
        let outcome = {
            let stop = || {
                let mut held = held.borrow_mut();
                held.extend(rx.try_iter());
                let on = held.iter().fold(true, |on, cmd| match cmd {
                    LoudnessCmd::SetEnabled(v) => *v,
                    LoudnessCmd::Kick => on,
                });
                !on || self.scan_running()
            };
            visit(&self.conn, row, &stop)
        };
        for cmd in held.into_inner() {
            self.apply(cmd);
        }
        outcome
    }

    fn apply(&mut self, cmd: LoudnessCmd) {
        match cmd {
            LoudnessCmd::SetEnabled(on) => {
                if on && !self.enabled {
                    self.rewind();
                }
                self.enabled = on;
            }
            LoudnessCmd::Kick => self.rewind(),
        }
    }

    fn rewind(&mut self) {
        self.cursor = 0;
        self.roots.clear();
    }

    /// Waits up to `timeout` for a command. False once every sender is gone.
    fn wait(&mut self, rx: &Receiver<LoudnessCmd>, timeout: Duration) -> bool {
        match rx.recv_timeout(timeout) {
            Ok(cmd) => {
                self.apply(cmd);
                true
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => false,
        }
    }

    fn scan_running(&self) -> bool {
        self.app
            .state::<AppState>()
            .scan_running
            .load(Ordering::SeqCst)
    }

    /// Whether the row's root can be listed. A row with no root, or a root that is gone, is not held
    /// back here; its own file check decides.
    fn root_online(&mut self, root_id: Option<i64>) -> bool {
        let Some(id) = root_id else {
            return true;
        };
        if let Some(&online) = self.roots.get(&id) {
            return online;
        }
        let online = match db::root_target(&self.conn, id) {
            Ok(Some((_, path))) => root_reachable(Path::new(&path)),
            _ => true,
        };
        self.roots.insert(id, online);
        online
    }

    fn emit_progress(&mut self, terminal: bool) {
        let now_ms = self.started.elapsed().as_millis() as u64;
        if !self.throttle.should_emit(now_ms, terminal) {
            return;
        }
        if let Ok(coverage) = queue::coverage(&self.conn) {
            let _ = self.app.emit("loudness:progress", &coverage);
        }
    }
}

/// Visits one pending row: the tags backfill when the tags were never examined, then a measurement when
/// no tag track gain turned up and no current stamp exists. `stop` is polled between packets.
fn visit(conn: &Connection, row: &PendingRow, stop: &dyn Fn() -> bool) -> rusqlite::Result<Visit> {
    let stamp = Stamp {
        size_bytes: row.size_bytes,
        mtime: row.mtime,
    };
    let current = Some((stamp.size_bytes, stamp.mtime));
    // A file that is gone, offline, locked or rewritten since the scan is left for a later sweep or the
    // next scan, never stamped.
    if file_stats(&row.path) != current || std::fs::File::open(&row.path).is_err() {
        return Ok(Visit::Left);
    }

    let mut needs_measure = row.needs_measure;
    if row.needs_tags {
        let tags = writer::read_gain_tags(&row.path);
        if !writer::write_gain_tags(conn, row.id, stamp, &tags)? {
            return Ok(Visit::Left);
        }
        needs_measure &= tags.track_gain.is_none();
    }
    if !needs_measure {
        return Ok(Visit::Done);
    }

    let Some(loudness) = measure(&row.path, stop) else {
        return Ok(Visit::Stopped);
    };
    // The file can change or drop offline under a long decode; such a read describes no version.
    if file_stats(&row.path) != current {
        return Ok(Visit::Left);
    }
    Ok(if writer::write_loudness(conn, row.id, stamp, loudness)? {
        Visit::Done
    } else {
        Visit::Left
    })
}

/// Decodes the whole file into the meter. None when `stop` cut it short; Some(None) when the file
/// cannot be decoded, changes layout mid-stream, or has no gated loudness.
fn measure(path: &Path, stop: &dyn Fn() -> bool) -> Option<Option<Loudness>> {
    let Ok(mut decoder) = Decoder::open(path) else {
        return Some(None);
    };
    let mut meter: Option<(Meter, (u32, u16))> = None;
    while let Some(chunk) = decoder.next_packet() {
        if stop() {
            return None;
        }
        let layout = (chunk.spec.sample_rate, chunk.spec.channels);
        let (m, opened) = match meter.as_mut() {
            Some(entry) => entry,
            None => {
                let Some(m) = Meter::new(layout.0, usize::from(layout.1)) else {
                    return Some(None);
                };
                meter.insert((m, layout))
            }
        };
        if *opened != layout {
            return Some(None);
        }
        m.push(&chunk.samples);
    }
    let Some((m, _)) = meter else {
        return Some(None);
    };
    Some(m.integrated().map(|lufs| Loudness {
        lufs,
        peak: m.peak(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;

    use crate::loudness::queue::next_pending;

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_loudness_{tag}_{}_{n}_{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A 16-bit stereo PCM WAV holding `secs` of a 1 kHz sine at `dbfs` peak amplitude.
    fn write_sine_wav(path: &Path, rate: u32, dbfs: f64, secs: f64) {
        let channels = 2u16;
        let frames = (f64::from(rate) * secs) as usize;
        let data_len = (frames * usize::from(channels) * 2) as u32;
        let mut v = Vec::with_capacity(44 + data_len as usize);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        v.extend_from_slice(&(channels * 2).to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        let amp = 10f64.powf(dbfs / 20.0) * f64::from(i16::MAX);
        for n in 0..frames {
            let t = n as f64 / f64::from(rate);
            let s = (amp * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as i16;
            for _ in 0..channels {
                v.extend_from_slice(&s.to_le_bytes());
            }
        }
        fs::write(path, v).unwrap();
    }

    /// Indexes `path` as a present row at its real stats, tags never examined, and returns its id.
    fn index(conn: &Connection, path: &Path) -> i64 {
        let (size, mtime) = file_stats(path).unwrap_or((10, 20));
        let p = path.to_string_lossy();
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at)
             VALUES (?1, ?1, 'f', 'wav', ?2, ?3, 0, 30)",
            rusqlite::params![p, size, mtime],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    type Stored = (Option<i64>, Option<f64>, Option<f64>, Option<i64>);

    fn stored(conn: &Connection, id: i64) -> Stored {
        conn.query_row(
            "SELECT gain_tags_read, loudness_lufs, loudness_peak, loudness_size FROM tracks
             WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    fn visit_first(conn: &Connection, stop: &dyn Fn() -> bool) -> Visit {
        let row = next_pending(conn, 0).unwrap().unwrap();
        visit(conn, &row, stop).unwrap()
    }

    #[test]
    fn a_decodable_file_is_measured_and_leaves_the_queue() {
        let dir = TempDir::new("measured");
        let path = dir.path.join("tone.wav");
        write_sine_wav(&path, 48_000, -23.0, 5.0);
        let conn = db::open_in_memory().unwrap();
        let id = index(&conn, &path);

        assert_eq!(visit_first(&conn, &|| false), Visit::Done);
        let (read, lufs, peak, size) = stored(&conn, id);
        assert_eq!(read, Some(1));
        assert!((lufs.unwrap() + 23.0).abs() <= 0.1, "{lufs:?}");
        assert!((peak.unwrap() - 10f64.powf(-23.0 / 20.0)).abs() < 1e-3);
        assert_eq!(size, file_stats(&path).map(|s| s.0));
        assert_eq!(next_pending(&conn, 0).unwrap(), None);
    }

    #[test]
    fn an_unreachable_file_is_not_stamped() {
        let dir = TempDir::new("unreachable");
        let conn = db::open_in_memory().unwrap();
        let id = index(&conn, &dir.path.join("offline.flac"));

        assert_eq!(visit_first(&conn, &|| false), Visit::Left);
        assert_eq!(stored(&conn, id), (None, None, None, None));
        assert!(next_pending(&conn, 0).unwrap().is_some(), "still queued");
    }

    #[test]
    fn an_opened_but_undecodable_file_is_stamped_with_no_value() {
        let dir = TempDir::new("undecodable");
        let path = dir.path.join("junk.flac");
        fs::write(&path, b"not audio at all").unwrap();
        let conn = db::open_in_memory().unwrap();
        let id = index(&conn, &path);

        assert_eq!(visit_first(&conn, &|| false), Visit::Done);
        let (read, lufs, peak, size) = stored(&conn, id);
        assert_eq!((read, lufs, peak), (Some(1), None, None));
        assert_eq!(size, Some(16));
        assert_eq!(next_pending(&conn, 0).unwrap(), None, "tried once");
    }

    #[test]
    fn a_silent_file_is_stamped_with_no_value() {
        let dir = TempDir::new("silent");
        let path = dir.path.join("silence.wav");
        write_sine_wav(&path, 44_100, -200.0, 2.0);
        let conn = db::open_in_memory().unwrap();
        let id = index(&conn, &path);

        assert_eq!(visit_first(&conn, &|| false), Visit::Done);
        let (read, lufs, _, size) = stored(&conn, id);
        assert_eq!((read, lufs), (Some(1), None));
        assert!(size.is_some());
    }

    #[test]
    fn a_row_that_moves_mid_measure_is_not_stamped() {
        let dir = TempDir::new("moved");
        let path = dir.path.join("tone.wav");
        write_sine_wav(&path, 48_000, -23.0, 3.0);
        let db_path = dir.path.join("plisto.sqlite");
        let conn = db::open_db(&db_path).unwrap();
        let id = index(&conn, &path);

        // A rescan lands while the decode runs and records a new mtime for the row.
        let rescan = db::open_db(&db_path).unwrap();
        let moved = std::cell::Cell::new(false);
        let stop = || {
            if !moved.get() {
                rescan
                    .execute("UPDATE tracks SET mtime = mtime + 1 WHERE id = ?1", [id])
                    .unwrap();
                moved.set(true);
            }
            false
        };
        assert_eq!(visit_first(&conn, &stop), Visit::Left);
        let (_, lufs, _, size) = stored(&conn, id);
        assert_eq!((lufs, size), (None, None));
    }

    #[test]
    fn a_stopped_measure_writes_nothing() {
        let dir = TempDir::new("stopped");
        let path = dir.path.join("tone.wav");
        write_sine_wav(&path, 48_000, -23.0, 2.0);
        let conn = db::open_in_memory().unwrap();
        let id = index(&conn, &path);
        conn.execute("UPDATE tracks SET gain_tags_read = 1 WHERE id = ?1", [id])
            .unwrap();

        assert_eq!(visit_first(&conn, &|| true), Visit::Stopped);
        assert_eq!(stored(&conn, id), (Some(1), None, None, None));
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Runs one full worker visit over every pending row, never stopping. The scan and export pins use
    /// it to write through the worker's own path.
    pub(crate) fn visit_all(conn: &Connection) {
        let mut after = 0;
        while let Some(row) = queue::next_pending(conn, after).unwrap() {
            visit(conn, &row, &|| false).unwrap();
            after = row.id;
        }
    }
}
