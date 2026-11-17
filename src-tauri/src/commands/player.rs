/*
 * The IPC command surface for playback. This is the only player file that touches the database: it
 * resolves track ids to file paths, then hands a DB-free queue to the resident engine over the
 * command channel. Every transport command is a fire-and-forget send - the engine owns all state
 * and reports back through `player:status` events and the shared snapshot `get_player_status` reads.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rodio::cpal;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use tauri::{AppHandle, Emitter, Manager, State};

// -- Local Imports --
use crate::adhoc::{next_ad_hoc_id, AdHocTrack};
use crate::audio::{
    index_of_id, track_gain_db, GainInputs, OutputDeviceInfo, PlayerCmd, PlayerNotice,
    PlayerStatus, QueueMirror, QueueTrack, RepeatMode,
};
use crate::covers::InFlightGuard;
use crate::db;
use crate::model::RawTags;
use crate::state::AppState;

// -- Module Declarations --
mod staging;

use staging::read_ad_hoc_tracks;

/// The file path and levelling gain of each id that still resolves (a deleted row does not). Empty
/// when the lock is poisoned. The only DB work the player does; the engine never sees a connection.
fn resolve_rows(track_ids: &[i64], state: &AppState) -> HashMap<i64, (String, f32)> {
    let resolved: Vec<(i64, String, f32)> = match state.db.lock() {
        Ok(conn) => db::load_queue_tracks(&conn, track_ids).unwrap_or_default(),
        Err(_) => return HashMap::new(),
    };
    resolved.into_iter().map(|(id, p, g)| (id, (p, g))).collect()
}

/// Builds the queue along `track_ids` from the rows that resolved, each track carrying its mark
/// from `marks`, and returns where `start` lands in it: a start on a row left out moves to the next
/// row kept. Marks are read by request position before any row drops, so a block keeps whatever
/// of it survives.
fn marked_queue(
    track_ids: &[i64],
    marks: &[Option<u64>],
    rows: &HashMap<i64, (String, f32)>,
    start: usize,
) -> (Vec<QueueTrack>, usize) {
    let mut queue = Vec::with_capacity(track_ids.len());
    let mut kept_before = 0;
    for (i, id) in track_ids.iter().enumerate() {
        let Some((path, gain_db)) = rows.get(id) else {
            continue;
        };
        if i < start {
            kept_before += 1;
        }
        queue.push(QueueTrack {
            id: *id,
            path: PathBuf::from(path),
            gain_db: *gain_db,
            block: marks.get(i).copied().flatten(),
            detached: false,
        });
    }
    (queue, kept_before)
}

/// One mark per requested row from the frontend's `[start, length]` block spans: the span's ordinal
/// on its rows, None elsewhere. An empty span, one past the end of `len` rows, or one overlapping an
/// earlier span is dropped.
pub(crate) fn marks_from_spans(len: usize, spans: &[[usize; 2]]) -> Vec<Option<u64>> {
    let mut marks = vec![None; len];
    for (ordinal, &[start, length]) in spans.iter().enumerate() {
        let Some(end) = start.checked_add(length).filter(|&end| length > 0 && end <= len) else {
            continue;
        };
        if marks[start..end].iter().any(Option::is_some) {
            continue;
        }
        marks[start..end].fill(Some(ordinal as u64));
    }
    marks
}

/// Resolves track ids to a DB-free queue with each track's levelling gain, keeping the caller's order
/// and dropping ids that no longer resolve (a deleted row). No track is in a block. Returns an empty
/// queue when the lock is poisoned.
pub(crate) fn resolve_queue(track_ids: &[i64], state: &AppState) -> Vec<QueueTrack> {
    marked_queue(track_ids, &[], &resolve_rows(track_ids, state), 0).0
}

/// `resolve_queue` with the frontend's block spans, and where `start` lands in the result.
fn resolve_with_blocks(
    track_ids: &[i64],
    blocks: Option<Vec<[usize; 2]>>,
    start: usize,
    state: &AppState,
) -> (Vec<QueueTrack>, usize) {
    let marks = marks_from_spans(track_ids.len(), blocks.as_deref().unwrap_or_default());
    marked_queue(track_ids, &marks, &resolve_rows(track_ids, state), start)
}

/// The slot `player_load` seats: `index` when that row holds `current_id`, else its first copy.
fn seat_index(queue: &[QueueTrack], current_id: i64, index: Option<usize>) -> Option<usize> {
    index
        .filter(|&i| queue.get(i).is_some_and(|t| t.id == current_id))
        .or_else(|| index_of_id(queue, current_id))
}

/// Resolves the given track ids to their files and starts playback at `index`. Ids that no longer
/// resolve (a deleted row) drop out of the queue, and `index` moves with the rows kept before it.
/// `blocks` are `[start, length]` spans over `track_ids` whose tracks play together. An empty
/// resolution is a no-op.
#[tauri::command]
pub fn player_play_tracks(
    track_ids: Vec<i64>,
    index: usize,
    blocks: Option<Vec<[usize; 2]>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (queue, index) = resolve_with_blocks(&track_ids, blocks, index, &state);
    if queue.is_empty() {
        return Ok(());
    }
    let index = index.min(queue.len() - 1);
    let _ = state.player.send(PlayerCmd::Play { queue, index });
    Ok(())
}

/// Seats the saved queue paused on `current_id` at `secs`, never playing. `index` names the saved
/// row of the current track, which tells apart two copies of it; when that row no longer holds it
/// after resolution, the first copy is seated. Returns false, loading nothing, when the current track
/// no longer resolves.
#[tauri::command]
pub fn player_load(
    track_ids: Vec<i64>,
    current_id: i64,
    secs: f64,
    index: Option<usize>,
    blocks: Option<Vec<[usize; 2]>>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let Some(cmd) = load_command(&track_ids, current_id, secs, index, blocks, &state) else {
        return Ok(false);
    };
    let _ = state.player.send(cmd);
    Ok(true)
}

/// The `Load` that `player_load` sends, or None when the current track no longer resolves.
fn load_command(
    track_ids: &[i64],
    current_id: i64,
    secs: f64,
    index: Option<usize>,
    blocks: Option<Vec<[usize; 2]>>,
    state: &AppState,
) -> Option<PlayerCmd> {
    let (queue, row) = resolve_with_blocks(track_ids, blocks, index.unwrap_or(0), state);
    let index = seat_index(&queue, current_id, index.map(|_| row))?;
    Some(PlayerCmd::Load { queue, index, secs })
}

/// Plays one or more files straight off disk, with no library rows behind them. Reads each file's tags
/// and caches its cover off the player thread, then stashes each under its own fresh negative id so
/// prev/next traverses the ad-hoc queue. Replaces the stash and queue on each open. An unreadable file
/// is skipped; when every file is unreadable nothing plays and a `player:error` File notice fires.
/// Shared by the single- and multi-file commands and the debounced intake buffer.
pub async fn play_files(app: &AppHandle, paths: Vec<String>) -> Result<(), String> {
    let (entries, queue) = stage_ad_hoc(app, paths).await?;
    // Each open rebuilds the queue, so the stash is replaced too: one entry per readable file, keyed
    // by the id the engine reports back for the current track.
    let state = app.state::<AppState>();
    {
        let mut stash = state
            .ad_hoc
            .lock()
            .map_err(|_| "player is unavailable".to_string())?;
        stash.clear();
        stash.extend(entries);
    }
    let _ = state.player.send(PlayerCmd::Play { queue, index: 0 });
    Ok(())
}

/// Appends one or more files straight off disk to the end of the queue, no library rows behind them: a
/// drop onto the player while a track already holds. The append half of `play_files`: it extends the
/// stash rather than replacing it, so the live source plays on, and sends `Enqueue`, not `Play`. Errors
/// when every file is unreadable, so the caller can surface it.
pub async fn enqueue_files(app: &AppHandle, paths: Vec<String>) -> Result<(), String> {
    let (entries, queue) = stage_ad_hoc(app, paths).await?;
    let state = app.state::<AppState>();
    {
        let mut stash = state
            .ad_hoc
            .lock()
            .map_err(|_| "player is unavailable".to_string())?;
        stash.extend(entries);
    }
    let _ = state.player.send(PlayerCmd::Enqueue(queue));
    Ok(())
}

/// Reads tags and caches covers for `paths` off the player thread, then allocates a fresh negative id per
/// readable file. The shared front half of the ad-hoc open and append: an unreadable file is dropped, and
/// an all-unreadable set emits the one `player:error` File notice and errors, so either caller surfaces
/// it the same way. Returns the stash entries keyed to their queue tracks, both in the caller's order.
async fn stage_ad_hoc(
    app: &AppHandle,
    paths: Vec<String>,
) -> Result<(HashMap<i64, AdHocTrack>, Vec<QueueTrack>), String> {
    let (covers_dir, guard) = {
        let state = app.state::<AppState>();
        (state.covers_dir.clone(), Arc::clone(&state.covers_in_flight))
    };

    // Read tags and cache covers for every file on one blocking hop, never the player thread, which
    // also waits out the decode helper's launch. Each readable file comes back with its path; an
    // unreadable one is dropped here.
    let readable = tauri::async_runtime::spawn_blocking(move || {
        read_ad_hoc_tracks(&covers_dir, &guard, paths)
    })
    .await
    .map_err(|_| "playback task failed to run".to_string())?;

    if readable.is_empty() {
        let _ = app.emit("player:error", PlayerNotice::File);
        return Err("couldn't read any of these files".to_string());
    }

    Ok(build_ad_hoc_queue(readable))
}

/// Allocates a fresh negative id for each readable file and pairs the stash entries with the queue
/// tracks, both keyed by the same ids so every queue entry resolves through the sentinel fan-out to
/// its own stash entry.
fn build_ad_hoc_queue(
    readable: Vec<(String, AdHocTrack, f32)>,
) -> (HashMap<i64, AdHocTrack>, Vec<QueueTrack>) {
    let mut entries = HashMap::with_capacity(readable.len());
    let mut queue = Vec::with_capacity(readable.len());
    for (path, track, gain_db) in readable {
        let id = next_ad_hoc_id();
        entries.insert(id, track);
        queue.push(QueueTrack {
            id,
            path: path.into(),
            gain_db,
            block: None,
            detached: false,
        });
    }
    (entries, queue)
}

/// Plays a file straight off disk, with no library row behind it, naming it from its own tags.
/// Delegates to the multi-file core with a one-entry list. Errors when the file cannot be read as
/// audio, so the caller can surface it. Async so the tag read and cover decode never touch the engine.
#[tauri::command]
pub async fn player_play_file(path: String, app: AppHandle) -> Result<(), String> {
    play_files(&app, vec![path]).await
}

/// Plays a set of files straight off disk, with no library rows: the multi-file open the OS delivers
/// or a multi-select feeds. Unreadable files drop out; playing starts on the first survivor. Errors
/// only when every file is unreadable, so a mixed set still plays its readable members.
#[tauri::command]
pub async fn player_play_files(paths: Vec<String>, app: AppHandle) -> Result<(), String> {
    play_files(&app, paths).await
}

/// Appends a set of files straight off disk to the queue, with no library rows: a drop onto the player
/// while a track already holds. Unreadable files drop out; errors only when every file is unreadable, so
/// a mixed drop still queues its readable members. Async so the tag read and cover decode never touch the
/// engine.
#[tauri::command]
pub async fn player_enqueue_files(paths: Vec<String>, app: AppHandle) -> Result<(), String> {
    enqueue_files(&app, paths).await
}

/// Returns the file paths Plisto was cold-launched with, then clears them so a later reload never
/// replays the file. The boot-race-safe path: the frontend pulls this on mount rather than the setup
/// hook pushing an event, so a slow first render never misses it. None when Plisto opened on its own.
#[tauri::command]
pub fn get_startup_file(state: State<'_, AppState>) -> Result<Option<Vec<String>>, String> {
    let mut slot = state
        .startup_file
        .lock()
        .map_err(|_| "startup file is unavailable".to_string())?;
    Ok(slot.take())
}

/// Returns and clears the notice from a failed OS-launch open - a burst of file-opens where every file
/// was unreadable. The standalone shell pulls it on mount, so its refusal body shows even when the intake
/// batch played and its `player:error` fired before the webview subscribed. None on the normal path, and
/// after the take, so a reload never re-reports it.
#[tauri::command]
pub fn get_startup_error(state: State<'_, AppState>) -> Result<Option<PlayerNotice>, String> {
    let mut slot = state
        .startup_error
        .lock()
        .map_err(|_| "startup error is unavailable".to_string())?;
    Ok(slot.take())
}

/// Reads a lone file's tags and resolves its cover for ad-hoc playback in this process, when no
/// decode helper can be set up. Errors when the file cannot be opened as audio (missing or
/// undecodable), so the caller reports it rather than queueing a dead track; a readable file with
/// no tags is fine - it falls back to the filename stem.
fn read_in_process(
    covers_dir: &Path,
    guard: &InFlightGuard,
    source_path: &str,
) -> Result<(AdHocTrack, f32), String> {
    let (raw, unreadable) = crate::scan::read_tags(Path::new(source_path));
    if unreadable {
        return Err("couldn't read this file".to_string());
    }
    let (title, artist) = ad_hoc_display(source_path, &raw);
    let cover = crate::commands::covers::cache_ad_hoc_cover(covers_dir, guard, source_path);
    let track = AdHocTrack {
        title,
        artist,
        cover,
    };
    Ok((track, ad_hoc_gain(source_path, &raw)))
}

/// The levelling gain a file's own ReplayGain tags give, 0 dB when untagged. There is no stored
/// measurement for a file outside the library.
fn ad_hoc_gain(source_path: &str, raw: &RawTags) -> f32 {
    let record = crate::normalize::normalize_track(source_path, 0, 0, 0, raw);
    track_gain_db(&GainInputs {
        tag_gain_db: record.rg_track_gain,
        tag_peak: record.rg_track_peak,
        opus: record.ext.eq_ignore_ascii_case("opus"),
        ..GainInputs::default()
    })
}

/// Builds an ad-hoc track's display fields from a file's raw tags and path, through the same
/// normalize boundary the scan runs: the cleaned tag title, else the filename stem so the track is
/// never nameless, and the cleaned tag artist, left None when the file carries none.
fn ad_hoc_display(source_path: &str, raw: &RawTags) -> (String, Option<String>) {
    let record = crate::normalize::normalize_track(source_path, 0, 0, 0, raw);
    let title = record
        .raw_title
        .unwrap_or_else(|| filename_stem(&record.filename));
    (title, record.raw_artist)
}

/// The filename with its final extension dropped, or the whole name when it has none. The fallback
/// title for an ad-hoc track whose file carries no title tag.
fn filename_stem(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string())
}

/// Resolves the given track ids to their files and appends them to the end of the queue, `blocks`
/// as in `player_play_tracks`. An empty resolution is a no-op. Fire-and-forget like the other
/// transport commands.
#[tauri::command]
pub fn player_enqueue(
    track_ids: Vec<i64>,
    blocks: Option<Vec<[usize; 2]>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (queue, _) = resolve_with_blocks(&track_ids, blocks, 0, &state);
    if queue.is_empty() {
        return Ok(());
    }
    let _ = state.player.send(PlayerCmd::Enqueue(queue));
    Ok(())
}

/// Resolves the given track ids and inserts them right after the playing track, or after the end of
/// its block, `blocks` as in `player_play_tracks`. An empty resolution is a no-op. Fire-and-forget
/// like the other transport commands.
#[tauri::command]
pub fn player_play_next(
    track_ids: Vec<i64>,
    blocks: Option<Vec<[usize; 2]>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (queue, _) = resolve_with_blocks(&track_ids, blocks, 0, &state);
    if queue.is_empty() {
        return Ok(());
    }
    let _ = state.player.send(PlayerCmd::InsertNext(queue));
    Ok(())
}

/// Moves the queue item at `from` to `to`, like a drag in the up-next list. Out-of-range indices are
/// ignored on the engine. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_move_queue_item(
    from: usize,
    to: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::MoveQueueItem { from, to });
    Ok(())
}

/// Removes the queue item at `index`, like a delete in the up-next list. An out-of-range index is
/// ignored on the engine. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_remove_queue_item(index: usize, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::RemoveQueueItem { index });
    Ok(())
}

/// Auditions the file at `path` between `start_secs` and `end_secs` on the resident engine, stopping
/// at the out-point. A transient preview for the splicer workbench: it leaves the library queue and
/// cursor untouched, so playback restores after. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_preview(
    path: String,
    start_secs: f64,
    end_secs: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Preview {
        path: path.into(),
        start_secs,
        end_secs,
    });
    Ok(())
}

/// Reopens the current library track at `secs` and restores its paused state on the resident engine,
/// after a preview cleared the sink. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_restore_library(
    secs: f64,
    playing: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state
        .player
        .send(PlayerCmd::RestoreLibrary { secs, playing });
    Ok(())
}

/// Toggles between play and pause.
#[tauri::command]
pub fn player_toggle(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::TogglePlay);
    Ok(())
}

/// Pauses playback, holding the current position.
#[tauri::command]
pub fn player_pause(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Pause);
    Ok(())
}

/// Resumes from the held position.
#[tauri::command]
pub fn player_resume(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Resume);
    Ok(())
}

/// Stops playback and clears the current track.
#[tauri::command]
pub fn player_stop(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Stop);
    Ok(())
}

/// Empties the queue parked under a plugin stream; the stream plays on. Ignored with no stream.
#[tauri::command]
pub fn player_clear_parked(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::ClearParked);
    Ok(())
}

/// Skips to the next track, honoring the repeat mode.
#[tauri::command]
pub fn player_next(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Next);
    Ok(())
}

/// Steps back to the previous track.
#[tauri::command]
pub fn player_prev(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Prev);
    Ok(())
}

/// Jumps straight to the queue slot at `index`, like a click in the up-next list. The engine clamps
/// an over-range index to the last slot and skips a dead track forward, so this never lands nowhere.
#[tauri::command]
pub fn player_jump(index: usize, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Jump(index));
    Ok(())
}

/// Seeks the current track to `secs` from the start.
#[tauri::command]
pub fn player_seek(secs: f64, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Seek(secs));
    Ok(())
}

/// Sets the output volume, clamped to [0.0, 1.0] on the engine.
#[tauri::command]
pub fn player_set_volume(v: f32, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetVolume(v));
    Ok(())
}

/// Sets the repeat mode: off, all, or one.
#[tauri::command]
pub fn player_set_repeat(mode: RepeatMode, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetRepeat(mode));
    Ok(())
}

/// Turns shuffle on or off. On materializes a shuffled queue order with the current track pinned to
/// the front; off restores the original insertion order. The current track keeps playing either way.
#[tauri::command]
pub fn player_set_shuffle(on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetShuffle(on));
    Ok(())
}

/// Turns the 128-band `player:spectrum_fine` emit on or off. A visualizer that draws it turns it on
/// while mounted and off when it goes, so the extra analysis runs only while something reads it.
#[tauri::command]
pub fn player_set_fine_spectrum(on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetFineSpectrum(on));
    Ok(())
}

/// Enumerates the available output devices for the settings picker, flagging the current OS default.
/// Runs on the command worker thread - only names cross back, never a `!Send` device handle. The
/// engine builds its own device on its own thread when a pick arrives.
#[tauri::command]
pub fn list_output_devices() -> Result<Vec<OutputDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let list = devices
        .filter_map(|dev| dev.name().ok())
        .map(|name| OutputDeviceInfo {
            is_default: Some(&name) == default_name.as_ref(),
            name,
        })
        .collect();
    Ok(list)
}

/// Picks the output device: None follows the system default, Some pins that named device. Fire-and-
/// forget like the transport commands; the engine rebinds on its thread and reports back through the
/// status snapshot and any `player:error`.
#[tauri::command]
pub fn player_set_output_device(
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetOutputDevice(name));
    Ok(())
}

/// The current app-global playback snapshot, for a UI opening or reconnecting mid-play. Reads the
/// shared status the engine keeps live every tick, independent of the event stream.
#[tauri::command]
pub fn get_player_status(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    let status = state
        .player_status
        .lock()
        .map_err(|_| "player status is unavailable".to_string())?;
    Ok(status.clone())
}

/// The ordered queue track ids, for a UI building its up-next list on open or reconnect. Reads the
/// shared mirror the engine writes on every queue change, so it never waits on the `player:queue`
/// event. In the active play order, shuffled or not.
#[tauri::command]
pub fn get_player_queue(state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    let queue = state
        .player_queue
        .lock()
        .map_err(|_| "player queue is unavailable".to_string())?;
    Ok(queue.ids.clone())
}

/// The ordered queue track ids with the block spans over them, from the same mirror as
/// `get_player_queue`, so the two never come from different queues. What `player:queue_state`
/// carries.
#[tauri::command]
pub fn get_player_queue_state(state: State<'_, AppState>) -> Result<QueueMirror, String> {
    let queue = state
        .player_queue
        .lock()
        .map_err(|_| "player queue is unavailable".to_string())?;
    Ok(queue.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Raw tags carrying only a title and artist, the two fields ad-hoc display reads.
    fn raw(title: Option<&str>, artist: Option<&str>) -> RawTags {
        RawTags {
            title: title.map(str::to_string),
            artist: artist.map(str::to_string),
            ..RawTags::default()
        }
    }

    #[test]
    fn ad_hoc_display_prefers_the_tag_title() {
        let (title, artist) = ad_hoc_display("/music/my song.mp3", &raw(Some("Real Title"), Some("Real Artist")));
        assert_eq!(title, "Real Title", "the tag title wins over the filename");
        assert_eq!(artist.as_deref(), Some("Real Artist"));
    }

    #[test]
    fn ad_hoc_display_falls_back_to_the_filename_stem() {
        // No title tag and no artist: the stem names the track and the artist stays None.
        let (title, artist) = ad_hoc_display("/music/My Song.flac", &raw(None, None));
        assert_eq!(title, "My Song");
        assert_eq!(artist, None, "an absent artist tag stays None, never empty");
    }

    #[test]
    fn ad_hoc_display_treats_a_blank_title_as_absent() {
        // A whitespace-only title collapses to None through the normalize boundary, so the stem wins.
        let (title, _) = ad_hoc_display("/music/track01.opus", &raw(Some("   "), None));
        assert_eq!(title, "track01");
    }

    // A bare ad-hoc track carrying only a title, enough to key it in the stash and queue.
    fn track(title: &str) -> AdHocTrack {
        AdHocTrack {
            title: title.to_string(),
            artist: None,
            cover: None,
        }
    }

    #[test]
    fn build_ad_hoc_queue_gives_each_file_its_own_id() {
        let readable = vec![
            ("/music/a.mp3".to_string(), track("A"), -3.0),
            ("/music/b.flac".to_string(), track("B"), 0.0),
            ("/music/c.wav".to_string(), track("C"), 0.0),
        ];
        let (entries, queue) = build_ad_hoc_queue(readable);

        assert_eq!(queue.len(), 3, "every readable file becomes a queue entry");
        assert_eq!(entries.len(), 3, "the stash carries one entry per file");
        // Each queue id keys its own stash entry, so the sentinel fan-out resolves every entry apart.
        for (i, name) in ["A", "B", "C"].iter().enumerate() {
            let id = queue[i].id;
            assert!(id < 0, "an ad-hoc id is always negative");
            assert_eq!(entries[&id].title, *name, "the stash entry matches its queue slot");
        }
        assert_eq!(queue[0].gain_db, -3.0, "the tagged gain rides the queue entry");
        // The paths keep the caller's order.
        let paths: Vec<_> = queue.iter().map(|q| q.path.to_string_lossy().into_owned()).collect();
        assert_eq!(paths, vec!["/music/a.mp3", "/music/b.flac", "/music/c.wav"]);
    }

    // ---- Block spans ----

    // Resolved rows for `ids`, as `resolve_rows` returns them.
    fn rows(ids: &[i64]) -> HashMap<i64, (String, f32)> {
        ids.iter().map(|&id| (id, (format!("/music/{id}.flac"), 0.0))).collect()
    }

    fn copies(queue: &[QueueTrack]) -> Vec<(i64, Option<u64>)> {
        queue.iter().map(|t| (t.id, t.block)).collect()
    }

    #[test]
    fn marks_from_spans_drops_empty_overlapping_and_out_of_range_spans() {
        let spans = [[0, 2], [1, 2], [4, 0], [5, 3], [3, 3], [usize::MAX, 2]];
        let marks = marks_from_spans(6, &spans);
        assert_eq!(marks, vec![Some(0), Some(0), None, Some(4), Some(4), Some(4)]);
        assert_eq!(marks_from_spans(2, &[]), vec![None, None]);
    }

    #[test]
    fn a_dropped_row_shrinks_its_block_and_moves_the_start() {
        let ids = [10, 11, 12, 13, 14];
        let marks = marks_from_spans(ids.len(), &[[1, 3]]);
        // Ids 10 and 12 no longer resolve.
        let rows = rows(&[11, 13, 14]);
        let (queue, start) = marked_queue(&ids, &marks, &rows, 3);
        assert_eq!(copies(&queue), vec![(11, Some(0)), (13, Some(0)), (14, None)]);
        assert_eq!(queue[start].id, 13);
        // A start on a dropped row moves to the next row kept.
        let (_, start) = marked_queue(&ids, &marks, &rows, 2);
        assert_eq!(start, 1);
    }

    #[test]
    fn player_load_seats_the_saved_copy_or_falls_back_to_the_first() {
        // Id 5 no longer resolves; the album 1-2 is queued twice behind it.
        let ids = [5, 1, 2, 1, 2];
        let marks = marks_from_spans(ids.len(), &[[1, 2], [3, 2]]);
        let rows = rows(&[1, 2]);
        let (queue, row) = marked_queue(&ids, &marks, &rows, 3);
        assert_eq!(copies(&queue), vec![(1, Some(0)), (2, Some(0)), (1, Some(1)), (2, Some(1))]);
        assert_eq!(seat_index(&queue, 1, Some(row)), Some(2));
        // A saved row that holds another track falls back to the first copy.
        assert_eq!(seat_index(&queue, 1, Some(1)), Some(0));
        assert_eq!(seat_index(&queue, 1, Some(9)), Some(0));
        assert_eq!(seat_index(&queue, 1, None), Some(0));
        assert_eq!(seat_index(&queue, 7, Some(0)), None);
    }

    #[test]
    fn player_load_resolves_marks_and_seats_the_saved_copy() {
        let conn = db::open_in_memory().unwrap();
        let insert = |path: &str| {
            conn.execute(
                "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at)
                 VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30)",
                [path],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        let (a, b) = (insert("/music/a.mp3"), insert("/music/b.mp3"));
        let state = AppState::for_test(conn, PathBuf::new());
        // A row that no longer resolves sits first; the album a-b is queued twice behind it.
        let ids = [999, a, b, a, b];
        let spans = Some(vec![[1, 2], [3, 2]]);
        let load = |index| load_command(&ids, a, 4.0, index, spans.clone(), &state);
        let seated = |cmd: Option<PlayerCmd>| match cmd {
            Some(PlayerCmd::Load { queue, index, secs }) => (copies(&queue), index, secs),
            _ => panic!("not a load"),
        };
        let (queue, index, secs) = seated(load(Some(3)));
        assert_eq!(queue, vec![(a, Some(0)), (b, Some(0)), (a, Some(1)), (b, Some(1))]);
        assert_eq!((index, secs), (2, 4.0));
        // A saved row holding another track seats the first copy.
        assert_eq!(seated(load(Some(2))).1, 0);
        assert!(load_command(&[999], a, 0.0, None, None, &state).is_none());
    }

    #[test]
    fn read_ad_hoc_tracks_skips_files_it_cannot_read() {
        // Missing files are unreadable through the tag reader, so every one drops out and nothing is
        // queued - the all-unreadable case play_files reports as an error.
        let session = crate::audio::stream::isolate::file::use_test_session(
            std::time::Duration::from_secs(15),
        );
        let guard = crate::covers::InFlightGuard::default();
        let readable = read_ad_hoc_tracks(
            Path::new("/covers"),
            &guard,
            vec![
                "/music/missing-one.mp3".to_string(),
                "/music/missing-two.flac".to_string(),
            ],
        );
        assert!(readable.is_empty(), "an unreadable file never reaches the queue");
        assert_eq!(session.launches(), 0, "a missing file never starts a helper");
    }
}
