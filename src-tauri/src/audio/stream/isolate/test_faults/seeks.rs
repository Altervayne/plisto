/*
 * Faulty helpers that misbehave behind a seek main sent and they never answer. Each waits until the
 * seek reaches it, so a test thread slow to ask for the seek cannot race them.
 */

// -- Library Imports --
use std::io::{self, BufReader};
use std::thread;

// -- Local Imports --
use super::{chunk, hold, spin, TestFault, REQUEST_PAUSE};
use crate::audio::stream::isolate::wire::{HelperFrame, MainFrame, MainReader, UncheckedSeam};
use crate::audio::stream::pcm::Seam;

/// The chain seams `ChainFloodSpin` and `ChainFloodIdle` send: more than the queue holds.
const CHAIN_FLOOD: usize = 5_000;

pub(super) type Reader = MainReader<BufReader<io::Stdin>>;

/// Opens seeks and reads main's frames until a `Seek` arrives. False when main's pipe broke first.
pub(super) fn open_seeks_and_await_one(reader: &mut Reader, out: &mut io::Stdout) -> bool {
    if HelperFrame::SeeksOpen.write(out).is_err() {
        return false;
    }
    loop {
        match reader.read_frame() {
            Ok(Some(MainFrame::Seek { .. })) => return true,
            Ok(Some(_)) => {}
            _ => return false,
        }
    }
}

/// Runs `ChainFloodSpin`, `ChainFloodIdle` or `StaleFlood`, after `Open`.
pub(super) fn run(fault: TestFault, mut reader: Reader, mut out: io::Stdout) -> i32 {
    if !open_seeks_and_await_one(&mut reader, &mut out) {
        return 1;
    }
    let _unread = reader;
    match fault {
        TestFault::ChainFloodSpin | TestFault::ChainFloodIdle => {
            let chain = HelperFrame::Break(UncheckedSeam::new(Seam::Chain));
            if !(0..CHAIN_FLOOD).all(|_| chain.write(&mut out).is_ok()) {
                return 1;
            }
            if fault == TestFault::ChainFloodSpin {
                spin();
            }
            hold();
        }
        // Every chunk sent behind the seek is stale.
        TestFault::StaleFlood => loop {
            if chunk().write(&mut out).is_err() {
                return 1;
            }
            thread::sleep(REQUEST_PAUSE);
        },
        _ => 1,
    }
}
