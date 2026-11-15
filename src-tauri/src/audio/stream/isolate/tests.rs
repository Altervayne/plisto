/*
 * The helper's side, served in this process: `serve` over two pipes, with the test playing the main
 * process frame by frame. Every wait on the helper is bounded, so a helper that stops answering
 * fails its test instead of hanging it.
 */

// -- Library Imports --
use std::io::{self, PipeReader, PipeWriter, Read, Seek, SeekFrom};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

// -- Local Imports --
use super::helper::{known_hint, serve, Outlet};
use super::remote_source::RemoteSource;
use super::wire::{HelperFrame, HelperReader, MainFrame, UncheckedSeam, CHUNK_FRAMES_MAX};
use crate::audio::stream::test_media::{flac_bytes, wav_bytes};
use crate::audio::stream::{DecodeEnd, Seam};

const DEADLINE: Duration = Duration::from_secs(10);

/// The main process's ends of a helper served on a thread of this process.
struct Main {
    frames: HelperReader<PipeReader>,
    to: PipeWriter,
    body: Vec<u8>,
    helper: JoinHandle<i32>,
}

fn start(body: Vec<u8>, hint: &str) -> Main {
    let (from_main, to) = io::pipe().unwrap();
    let (from_helper, to_main) = io::pipe().unwrap();
    let helper = thread::spawn(move || serve(from_main, to_main));
    let mut main = Main {
        frames: HelperReader::new(from_helper),
        to,
        body,
        helper,
    };
    assert!(matches!(
        main.frames.read_frame(),
        Ok(Some(HelperFrame::Ready))
    ));
    let len = main.body.len() as u64;
    main.send(MainFrame::Open {
        hint: Some(hint.into()),
        seekable: true,
        guarded: true,
        len: Some(len),
    });
    main
}

impl Main {
    fn send(&mut self, frame: MainFrame) {
        frame.write(&mut self.to).unwrap();
    }

    // Answers every read from the body and the n-th `CloseSeeks` with `on_close(n)`, until the
    // helper's `End`. Returns every frame but the reads, and the helper's exit code.
    fn run(
        mut self,
        mut on_close: impl FnMut(usize) -> Vec<MainFrame> + Send + 'static,
    ) -> (Vec<HelperFrame>, i32) {
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let mut seen = Vec::new();
            let mut closes = 0;
            loop {
                let frame = self.frames.read_frame().unwrap().expect("no End");
                match frame {
                    HelperFrame::Read { pos, max, .. } => {
                        let from = (pos as usize).min(self.body.len());
                        let to = (from + max as usize).min(self.body.len());
                        let reply = if from == to {
                            MainFrame::Eof
                        } else {
                            MainFrame::Data(self.body[from..to].to_vec())
                        };
                        self.send(reply);
                        continue;
                    }
                    HelperFrame::CloseSeeks => {
                        for reply in on_close(closes) {
                            self.send(reply);
                        }
                        closes += 1;
                    }
                    _ => {}
                }
                let end = matches!(frame, HelperFrame::End(_));
                seen.push(frame);
                if end {
                    break;
                }
            }
            let code = self.helper.join().unwrap();
            let _ = done.send((seen, code));
        });
        finished
            .recv_timeout(DEADLINE)
            .expect("the helper never ended")
    }
}

fn seek_breaks(frames: &[HelperFrame], generation: u64) -> usize {
    let answer = HelperFrame::Break(UncheckedSeam::new(Seam::Seek(generation)))
        .encode()
        .unwrap();
    frames
        .iter()
        .filter(|f| f.encode().is_ok_and(|bytes| bytes == answer))
        .count()
}

fn ends_finished(frames: &[HelperFrame]) -> bool {
    matches!(frames.last(), Some(HelperFrame::End(DecodeEnd::Finished)))
}

#[test]
fn a_seek_also_returned_by_close_seeks_is_answered_once() {
    let seek = MainFrame::Seek {
        secs: 0.5,
        generation: 1,
    };
    let closed = MainFrame::SeeksClosed {
        pending: Some((0.5, 1)),
    };
    // Both orders: the seek frame before the close's answer, and after it.
    for replies in [
        vec![seek.clone(), closed.clone()],
        vec![closed.clone(), seek.clone()],
    ] {
        let main = start(wav_bytes(8_000, 1, 8_000), "wav");
        let (frames, code) = main.run(move |n| match n {
            0 => replies.clone(),
            _ => vec![MainFrame::SeeksClosed { pending: None }],
        });
        assert_eq!(code, 0);
        assert_eq!(seek_breaks(&frames, 1), 1);
        let closes = frames
            .iter()
            .filter(|f| matches!(f, HelperFrame::CloseSeeks))
            .count();
        assert_eq!(
            closes, 2,
            "the seek is served, then the stream closes again"
        );
        assert!(ends_finished(&frames));
    }
}

#[test]
fn a_decoded_block_over_the_chunk_cap_is_split() {
    let block = 2 * CHUNK_FRAMES_MAX as usize;
    let main = start(flac_bytes(2, block), "flac");
    let (frames, code) = main.run(|_| vec![MainFrame::SeeksClosed { pending: None }]);
    assert_eq!(code, 0);
    let chunks: Vec<usize> = frames
        .iter()
        .filter_map(|f| match f {
            HelperFrame::Chunk(chunk) => Some(chunk.frames()),
            _ => None,
        })
        .collect();
    assert!(
        chunks.iter().all(|&n| n <= CHUNK_FRAMES_MAX as usize),
        "{chunks:?}"
    );
    assert_eq!(chunks.iter().sum::<usize>(), 2 * block);
    assert!(ends_finished(&frames));
}

#[test]
fn an_unguarded_open_is_refused() {
    let (from_main, mut to) = io::pipe().unwrap();
    let (from_helper, to_main) = io::pipe().unwrap();
    let helper = thread::spawn(move || serve(from_main, to_main));
    let mut frames = HelperReader::new(from_helper);
    assert!(matches!(frames.read_frame(), Ok(Some(HelperFrame::Ready))));
    MainFrame::Open {
        hint: None,
        seekable: false,
        guarded: false,
        len: None,
    }
    .write(&mut to)
    .unwrap();
    assert_ne!(helper.join().unwrap(), 0);
    assert!(matches!(frames.read_frame(), Ok(None)));
}

#[test]
fn an_open_hint_maps_back_to_a_known_static_hint() {
    assert_eq!(known_hint(Some("ogg".into())), Some("ogg"));
    assert_eq!(known_hint(Some("m4a".into())), Some("m4a"));
    assert_eq!(known_hint(Some("exe".into())), None);
    assert_eq!(known_hint(Some("OGG".into())), None);
    assert_eq!(known_hint(None), None);
}

fn remote(replies: Vec<MainFrame>, seekable: bool, len: Option<u64>) -> RemoteSource {
    let out: Outlet = Arc::new(Mutex::new(Box::new(io::sink())));
    let (tx, rx) = crossbeam_channel::unbounded();
    for reply in replies {
        tx.send(reply).unwrap();
    }
    RemoteSource::new(out, rx, seekable, len)
}

#[test]
fn the_remote_source_takes_no_more_than_it_asked_for() {
    let mut source = remote(vec![MainFrame::Data(vec![7; 10])], true, Some(100));
    let mut buf = [0u8; 4];
    let err = source.read(&mut buf).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);

    let mut source = remote(
        vec![
            MainFrame::Data(vec![7; 4]),
            MainFrame::Eof,
            MainFrame::Broken,
        ],
        true,
        Some(100),
    );
    assert_eq!(source.read(&mut buf).unwrap(), 4);
    assert_eq!(source.read(&mut buf).unwrap(), 0);
    assert_eq!(
        source.read(&mut buf).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    // The main process gone reads as a broken source too.
    assert_eq!(
        source.read(&mut buf).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
}

#[test]
fn the_remote_source_seeks_within_the_body_only() {
    let mut source = remote(Vec::new(), true, Some(100));
    assert_eq!(source.seek(SeekFrom::End(-10)).unwrap(), 90);
    assert_eq!(source.seek(SeekFrom::Current(10)).unwrap(), 100);
    // At the end, a read is the end without asking main.
    assert_eq!(source.read(&mut [0u8; 4]).unwrap(), 0);
    assert!(source.seek(SeekFrom::Start(101)).is_err());
    assert!(source.seek(SeekFrom::Current(-200)).is_err());
    let mut ring = remote(Vec::new(), false, None);
    assert_eq!(
        ring.seek(SeekFrom::Start(0)).unwrap_err().kind(),
        io::ErrorKind::Unsupported
    );
}
