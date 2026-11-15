/*
 * Faulty helpers that try to earn their keep without delivering audio: a frame of audio at a time,
 * the same seek handed back again, or a stream of frames main must handle that carry nothing; and
 * one that burns CPU behind the queue it filled.
 */

// -- Library Imports --
use std::io::{self, Write};
use std::thread;
use std::time::{Duration, Instant};

// -- Local Imports --
use super::seeks::{open_seeks_and_await_one, Reader};
use super::{chunk, TestFault, BUSY_CHUNKS};
use crate::audio::stream::isolate::wire::{HelperFrame, MainFrame, UncheckedSeam};
use crate::audio::stream::pcm::Seam;
use crate::audio::{AudioSpec, PcmChunk};

/// The CPU `TinySpin` and `CloseSeeksSpin` burn between frames.
const BURN: Duration = Duration::from_millis(300);
/// The pause `TinySleep` takes between frames.
const TINY_PAUSE: Duration = Duration::from_secs(2);
/// The pause `SeeksOpenTrickle` takes between frames.
const TRICKLE_PAUSE: Duration = Duration::from_millis(20);

/// Runs one of this file's faults, after `Open`.
pub(super) fn run(fault: TestFault, mut reader: Reader, mut out: io::Stdout) -> i32 {
    let frame = || -> HelperFrame {
        HelperFrame::Chunk(PcmChunk {
            samples: vec![0.25],
            spec: AudioSpec {
                sample_rate: 8_000,
                channels: 1,
            },
        })
    };
    let chain = || HelperFrame::Break(UncheckedSeam::new(Seam::Chain));
    match fault {
        TestFault::TinySpin => loop {
            burn(BURN);
            if frame().write(&mut out).is_err() {
                return 1;
            }
        },
        TestFault::TinySleep => loop {
            thread::sleep(TINY_PAUSE);
            if frame().write(&mut out).is_err() {
                return 1;
            }
        },
        TestFault::CloseSeeksSpin | TestFault::CloseSeeksIdle => {
            // A seek from main, which is never answered.
            if !open_seeks_and_await_one(&mut reader, &mut out) {
                return 1;
            }
            loop {
                if fault == TestFault::CloseSeeksSpin {
                    burn(BURN);
                } else {
                    thread::sleep(BURN);
                }
                if HelperFrame::CloseSeeks.write(&mut out).is_err() {
                    return 1;
                }
                // Main's seeks and its answer, up to the answer.
                loop {
                    match reader.read_frame() {
                        Ok(Some(MainFrame::SeeksClosed { .. })) => break,
                        Ok(Some(_)) => {}
                        _ => return 1,
                    }
                }
            }
        }
        TestFault::SeeksOpenFlood => flood(HelperFrame::SeeksOpen, Duration::ZERO, out),
        TestFault::SeeksOpenTrickle => flood(HelperFrame::SeeksOpen, TRICKLE_PAUSE, out),
        TestFault::ChainStream => {
            // A seek from main, which is never answered.
            if !open_seeks_and_await_one(&mut reader, &mut out) {
                return 1;
            }
            let _unread = reader;
            flood(chain(), Duration::ZERO, out)
        }
        TestFault::BusyBehindFullQueue => busy_behind_full_queue(reader, out),
        _ => 1,
    }
}

// Writes `BUSY_CHUNKS` chunks while another thread burns CPU, so the CPU keeps running while main's
// full queue holds the writes back; then closes seeks and ends as a finished decode does.
fn busy_behind_full_queue(mut reader: Reader, mut out: io::Stdout) -> i32 {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let written = Arc::new(AtomicBool::new(false));
    let done = Arc::clone(&written);
    let burner = thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            std::hint::spin_loop();
        }
    });
    let sent = (0..BUSY_CHUNKS).all(|_| chunk().write(&mut out).is_ok());
    written.store(true, Ordering::Release);
    let _ = burner.join();
    if !sent || HelperFrame::CloseSeeks.write(&mut out).is_err() {
        return 1;
    }
    if !matches!(
        reader.read_frame(),
        Ok(Some(MainFrame::SeeksClosed { pending: None }))
    ) {
        return 1;
    }
    let end = HelperFrame::End(crate::audio::stream::DecodeEnd::Finished);
    match end.write(&mut out) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

fn burn(span: Duration) {
    let until = Instant::now() + span;
    while Instant::now() < until {
        std::hint::spin_loop();
    }
}

// Writes `frame` over and over, `pause` apart; a pause of zero writes as fast as the pipe takes it.
fn flood(frame: HelperFrame, pause: Duration, mut out: io::Stdout) -> i32 {
    let bytes = match frame.encode() {
        Ok(bytes) => bytes,
        Err(_) => return 1,
    };
    loop {
        if out.write_all(&bytes).and_then(|()| out.flush()).is_err() {
            return 1;
        }
        if !pause.is_zero() {
            thread::sleep(pause);
        }
    }
}
