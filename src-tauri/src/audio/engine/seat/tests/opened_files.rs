/*
 * Files the user opened (negative ids) through the engine's queue paths, each decoded by a real
 * helper in its container: play, seek and rebind on the seated helper, gapless preload, a queue
 * that crosses library tracks, a forged file, a helper that dies mid-file, files the queue meets
 * again after their helper failed, and a start past a file's end.
 */

use std::time::Instant;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

use super::*;
use crate::audio::stream::isolate::file::{
    file_key, use_test_session, FileDecode, FileSession, FILE_OPEN_MS,
};
use crate::audio::stream::{DecodeEnd, Fault};
use crate::audio::PlayerNotice;

const WAIT: Duration = Duration::from_secs(10);

// A session of this test's own, so its faulted record and launch count are its alone. The rig
// opens files on the test thread.
fn test_session() -> Arc<FileSession> {
    use_test_session(Duration::from_millis(FILE_OPEN_MS))
}

impl Rig {
    /// A ten-second opened file with id `id`, which must be negative.
    fn opened(&self, id: i64) -> QueueTrack {
        let path = self.dir.path.join(format!("o{}.wav", -id));
        write_wav(&path, RATE, 2, 10 * RATE as usize);
        QueueTrack {
            id,
            path,
            gain_db: 0.0,
        }
    }

    /// The helper decoding the current source.
    fn helper(&self) -> Arc<FileDecode> {
        let opened = self.engine.opened.as_ref().expect("an opened file plays");
        Arc::clone(&opened.decode)
    }

    fn file_notices(&self) -> usize {
        let file = serde_json::to_value(PlayerNotice::File).unwrap();
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|(event, value)| event == "player:error" && *value == file)
            .count()
    }

    fn hears_audio(&mut self) -> bool {
        (0..100).any(|_| self.pull(500).iter().any(|s| *s != 0.0))
    }
}

// `gapless_boundary`, with the preload armed while the sink is paused: a helper that is slow to
// start under load then never finds the current track already played out.
fn paused_gapless_boundary(r: &mut Rig) {
    r.handle(PlayerCmd::Pause);
    r.handle(PlayerCmd::Seek(9.5));
    r.tick();
    assert!(r.engine.pending.is_some(), "the preload is armed");
    r.handle(PlayerCmd::Resume);
    for _ in 0..1_000 {
        r.pull(500);
        let ended = r
            .engine
            .cur_ended
            .as_ref()
            .is_some_and(|e| e.load(Ordering::Relaxed));
        if ended {
            r.tick();
            return;
        }
    }
    panic!("the track never ended");
}

// Waits for the helper's end.
fn end_of(decode: &FileDecode) -> DecodeEnd {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(end) = decode.end() {
            return end;
        }
        assert!(Instant::now() < deadline, "the helper never ended");
        thread::sleep(Duration::from_millis(5));
    }
}

// A WAV whose `LIST` chunk declares a 4 GiB `INAM`: symphonia's probe allocates it whole.
fn forged_4gib_wav() -> Vec<u8> {
    let mut v = b"RIFF\xFF\xFF\xFF\xFFWAVEfmt ".to_vec();
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&44_100u32.to_le_bytes());
    v.extend_from_slice(&88_200u32.to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"LIST");
    v.extend_from_slice(&u32::MAX.to_le_bytes());
    v.extend_from_slice(b"INFOINAM");
    v.extend_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    v.extend_from_slice(b"title");
    v
}

fn kill(pid: u32) {
    // SAFETY: plain arguments; the handle is closed once, below.
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }.unwrap();
    // SAFETY: the handle is open until the close that follows.
    unsafe {
        TerminateProcess(process, 1).unwrap();
        let _ = CloseHandle(process);
    }
}

#[test]
fn an_opened_file_decodes_in_a_helper_and_reports_its_duration() {
    let mut r = rig();
    let queue = vec![r.opened(-1)];
    r.handle(PlayerCmd::Play { queue, index: 0 });

    let status = r.status();
    assert_eq!(status.track_id, Some(-1));
    assert!(status.playing);
    assert!(
        (status.duration_secs - 10.0).abs() < 1e-6,
        "{}",
        status.duration_secs
    );
    let decode = r.helper();
    assert!(
        decode.state().pid.get().is_some(),
        "a helper process decodes it"
    );
    assert!(r.hears_audio());
    assert!(r.engine.position_secs() > 0.0);

    // Stop ends the helper.
    r.handle(PlayerCmd::Stop);
    assert!(r.engine.opened.is_none());
    assert_eq!(end_of(&decode), DecodeEnd::Cancelled);
    assert_eq!(r.file_notices(), 0);
}

#[test]
fn seek_and_rebind_reuse_the_helper() {
    let mut r = rig();
    let queue = vec![r.opened(-1)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let decode = r.helper();

    r.handle(PlayerCmd::Seek(5.0));
    assert!(Arc::ptr_eq(&r.helper(), &decode));
    assert!((r.engine.position_secs() - 5.0).abs() < SLACK);
    assert_eq!(r.status().seek_seq, 1);
    assert!(r.hears_audio());

    // A seek while paused lands paused.
    r.handle(PlayerCmd::Pause);
    r.handle(PlayerCmd::Seek(2.0));
    assert!(Arc::ptr_eq(&r.helper(), &decode));
    assert!(r.sink().is_paused());
    assert!((r.engine.position_secs() - 2.0).abs() < SLACK);
    r.handle(PlayerCmd::Resume);

    // A device rebind seats the play head on the new sink from the same helper.
    r.pull(4_000);
    let position = r.engine.position_secs();
    let (sink, out) = Sink::new_idle();
    r.engine.sink = Some(sink);
    *r.output.out.lock().unwrap() = out;
    r.output.backlog.lock().unwrap().clear();
    assert!(r.call(|e| e.seek(position, false)));
    assert!(Arc::ptr_eq(&r.helper(), &decode));
    assert!((r.engine.position_secs() - position).abs() < SLACK);
    assert!(r.hears_audio());
    assert!(decode.end().is_none(), "the helper lives on");
}

#[test]
fn a_seek_after_the_whole_file_decoded_opens_it_again() {
    let mut r = rig();
    let queue = vec![r.opened(-1)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    // Near the end the helper decodes the rest of the file and exits.
    r.handle(PlayerCmd::Seek(9.5));
    let first = r.helper();
    assert_eq!(end_of(&first), DecodeEnd::Finished);

    r.handle(PlayerCmd::Seek(1.0));
    assert!(
        !Arc::ptr_eq(&r.helper(), &first),
        "a new helper serves the seek"
    );
    assert!((r.engine.position_secs() - 1.0).abs() < SLACK);
    assert!(r.hears_audio());
    assert_eq!(r.file_notices(), 0);
}

#[test]
fn preload_of_an_opened_file_joins_gapless() {
    let mut r = rig();
    let queue = vec![r.opened(-1), r.opened(-2)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let first = r.helper();

    paused_gapless_boundary(&mut r);
    assert_eq!(r.status().track_id, Some(-2));
    let second = r.helper();
    assert!(
        !Arc::ptr_eq(&first, &second),
        "the preload had its own helper"
    );
    assert!(r.status().playing);
    assert!(r.hears_audio());
    assert!(
        matches!(end_of(&first), DecodeEnd::Finished | DecodeEnd::Cancelled),
        "the first helper ended"
    );
    assert_eq!(r.file_notices(), 0);
}

#[test]
fn a_mixed_queue_crosses_library_and_opened_entries() {
    let mut r = rig();
    let queue = vec![r.track(1), r.opened(-1), r.track(2), r.opened(-2)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    assert!(r.engine.opened.is_none());

    // Library into an opened file, gaplessly.
    paused_gapless_boundary(&mut r);
    assert_eq!(r.status().track_id, Some(-1));
    let opened = r.helper();

    // An opened file into a library track, gaplessly: its helper is let go.
    paused_gapless_boundary(&mut r);
    assert_eq!(r.status().track_id, Some(2));
    assert!(r.engine.opened.is_none());
    assert!(matches!(
        end_of(&opened),
        DecodeEnd::Finished | DecodeEnd::Cancelled
    ));

    // A skip into an opened file and back out of it.
    r.handle(PlayerCmd::Next);
    assert_eq!(r.status().track_id, Some(-2));
    let skipped_to = r.helper();
    assert!(r.hears_audio());
    r.handle(PlayerCmd::Prev);
    assert_eq!(r.status().track_id, Some(2));
    assert!(r.engine.opened.is_none());
    assert_eq!(end_of(&skipped_to), DecodeEnd::Cancelled);
    assert!(r.hears_audio());
    assert_eq!(r.file_notices(), 0);
}

#[test]
fn a_forged_opened_file_is_skipped_with_the_file_notice_and_the_host_lives() {
    let session = test_session();
    let mut r = rig();
    let forged = r.dir.path.join("forged.wav");
    std::fs::write(&forged, forged_4gib_wav()).unwrap();
    let queue = vec![
        QueueTrack {
            id: -1,
            path: forged.clone(),
            gain_db: 0.0,
        },
        r.opened(-2),
    ];
    r.handle(PlayerCmd::Play { queue, index: 0 });

    assert_eq!(r.status().track_id, Some(-2));
    assert!(r.status().playing);
    assert_eq!(r.file_notices(), 1);
    // The forged file had a helper of its own, and that helper failed on it.
    assert_eq!(session.launches(), 2);
    assert!(session.is_faulted(&file_key(&forged)));
    assert!(r.hears_audio());
}

#[test]
fn repeat_one_on_a_file_that_kills_its_helper_notices_once_and_moves_on() {
    let session = test_session();
    let mut r = rig();
    let queue = vec![r.opened(-1), r.track(1)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    r.handle(PlayerCmd::SetRepeat(RepeatMode::One));
    let decode = r.helper();

    kill(*decode.state().pid.get().expect("the helper runs"));
    assert_eq!(end_of(&decode), DecodeEnd::Isolated(Fault::Crashed));
    r.pull_until_drained();
    r.tick();
    // The faulted file is passed over instead of replayed.
    assert_eq!(r.status().track_id, Some(1));
    assert_eq!(r.file_notices(), 1);
    assert_eq!(session.launches(), 1);
    r.tick();
    assert_eq!(r.file_notices(), 1);
    assert_eq!(session.launches(), 1);
}

#[test]
fn repeat_all_over_opened_files_that_all_kill_their_helpers_terminates() {
    let session = test_session();
    let mut r = rig();
    let queue = vec![r.opened(-1), r.opened(-2)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    r.handle(PlayerCmd::SetRepeat(RepeatMode::All));

    for id in [-1, -2] {
        assert_eq!(r.status().track_id, Some(id));
        let decode = r.helper();
        kill(*decode.state().pid.get().expect("the helper runs"));
        assert_eq!(end_of(&decode), DecodeEnd::Isolated(Fault::Crashed));
        r.pull_until_drained();
        r.tick();
    }
    // Coming round, both files are passed over and playback stops.
    assert_eq!(r.status().track_id, None);
    assert!(!r.engine.playing);
    assert_eq!(r.file_notices(), 2);
    assert_eq!(session.launches(), 2);
    r.tick();
    assert_eq!(session.launches(), 2);
}

#[test]
fn a_seek_on_a_helper_that_already_died_notices_once() {
    let session = test_session();
    let mut r = rig();
    let queue = vec![r.opened(-1), r.track(1)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let dead = r.helper();
    kill(*dead.state().pid.get().expect("the helper runs"));
    assert_eq!(end_of(&dead), DecodeEnd::Isolated(Fault::Crashed));

    // The user seeks before the queued audio ran out: a new helper serves the seek.
    r.handle(PlayerCmd::Seek(1.0));
    assert!(!Arc::ptr_eq(&r.helper(), &dead));
    assert_eq!(session.launches(), 2);
    assert_eq!(r.file_notices(), 1);
    assert!(r.hears_audio());
    r.handle(PlayerCmd::Stop);
    assert_eq!(r.file_notices(), 1);
}

#[test]
fn a_start_past_the_end_advances_with_no_notice() {
    test_session();
    let mut r = rig();
    let queue = vec![r.opened(-1), r.track(1)];
    r.handle(PlayerCmd::Load {
        queue,
        index: 0,
        secs: 20.0,
    });
    assert_eq!(r.status().track_id, Some(1));
    assert!(!r.status().playing, "a load lands paused");
    assert_eq!(r.file_notices(), 0);
}

#[test]
fn an_opened_file_with_no_audio_played_by_the_user_gives_the_notice_once() {
    let session = test_session();
    let mut r = rig();
    let path = r.dir.path.join("empty.wav");
    write_wav(&path, RATE, 2, 0);
    let queue = vec![QueueTrack {
        id: -1,
        path,
        gain_db: 0.0,
    }];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    assert_eq!(r.status().track_id, None);
    assert_eq!(session.launches(), 1, "its helper refused it");
    assert_eq!(r.file_notices(), 1);
    r.tick();
    assert_eq!(r.file_notices(), 1);
}

#[test]
fn a_helper_death_mid_file_advances_with_one_notice() {
    let mut r = rig();
    let queue = vec![r.opened(-1), r.track(1)];
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let decode = r.helper();
    assert!(r.hears_audio());

    kill(*decode.state().pid.get().expect("the helper runs"));
    assert_eq!(end_of(&decode), DecodeEnd::Isolated(Fault::Crashed));
    // What the helper queued plays out, and the file ends there.
    r.pull_until_drained();
    r.tick();
    assert_eq!(r.status().track_id, Some(1));
    assert!(r.engine.opened.is_none());
    assert_eq!(r.file_notices(), 1);
    r.tick();
    assert_eq!(r.file_notices(), 1);
    assert!(r.hears_audio());
}
