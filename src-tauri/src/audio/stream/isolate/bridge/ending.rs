/*
 * The item's end, decided once, and the guard that decides it on every way out of the bridge
 * thread's run.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

// -- Local Imports --
use super::lock;
use crate::audio::stream::StreamControl;
use crate::proc::job::Job;

/// The item's end, decided once. The pump acts on the queue and the control only while holding
/// `ended` and finding it false, so nothing from the helper reaches them after the decision.
/// `halt` stops a push or a send the pump is blocked in, so deciding waits at most one
/// `WAIT_SLICE` for the pump.
#[derive(Default)]
pub(super) struct EndGate {
    pub(super) halt: Arc<AtomicBool>,
    pub(super) ended: Mutex<bool>,
}

impl EndGate {
    pub(super) fn decide(&self) {
        self.halt.store(true, Ordering::Release);
        *lock(&self.ended) = true;
    }
}

/// Decides the end, kills the helper and closes the source when dropped.
pub(super) struct Ending<'a> {
    pub(super) gate: &'a EndGate,
    pub(super) job: &'a Job,
    pub(super) control: &'a StreamControl,
}

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        self.gate.decide();
        let _ = self.job.terminate();
        // The byte server's read wakes, and it drops the source as the decode thread would.
        self.control.close_source();
    }
}
