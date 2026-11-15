/*
 * The watchdog over a live helper: it feeds the `Ledger` what main sees of the helper and kills the
 * helper the ledger finds spinning or hung. The helper is paid in CPU for audio it delivers, and
 * nothing the helper sends restarts either clock.
 *
 * | Main                                  | The helper should | Spin credit       | Stall debt |
 * | ------------------------------------- | ----------------- | ----------------- | ---------- |
 * | accepts audio                         | send more         | earns, audio rate | pays back  |
 * | sent a new seek                       | answer it         | fills             | cleared    |
 * | waits on the pipe, or handles a frame | send audio        | earns, idle rate  | grows      |
 * |   that carries none                   |                   |                   |            |
 * | answers a read (network wait)         | wait              | earns, idle rate  | held       |
 * | pushes into a full queue              | wait              | earns, idle rate  | held       |
 *
 * In every state the credit pays the helper's CPU, by its job's accounting; it starts full at the
 * spin budget and never exceeds it, and spending past it is a spin. Audio a helper decodes ahead
 * into its own queue while main takes nothing is paid from the credit until main takes it, so the
 * budget must hold that queue's worth of decoding. A late stall step adds at most
 * `STALL_STEP_MAX`. What this bounds: a helper may use the idle rate's share of a
 * core indefinitely; one that delivers audio may use up to the audio rate per second of it, which
 * the queue holds to real time plus its depth; a burst is bounded by the spin budget plus one CPU
 * reading's interval. Audio main accepted is only discarded by the answer to a seek main asked
 * for, so a helper cannot earn the same queue depth twice on its own. A new seek is one with a
 * generation newer than any main sent before, in a `Seek` or handed back in `SeeksClosed`.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

// -- Local Imports --
use super::ledger::{Ledger, Limits};
use crate::audio::stream::Fault;
use crate::proc::job::Job;

/// What the pump and the bridge thread tell the watchdog.
#[derive(Default)]
pub(super) struct Activity {
    /// Audio the queue accepted, in microseconds.
    pub(super) audio_us: AtomicU64,
    /// The newest seek generation main sent the helper.
    pub(super) seek: AtomicU64,
    /// The pump is pushing into the queue, which waits while the queue is full.
    pub(super) pushing: AtomicBool,
}

impl Activity {
    /// Counts a seek main sent the helper, in a `Seek` or handed back in `SeeksClosed`.
    pub(super) fn seek_sent(&self, generation: u64) {
        self.seek.fetch_max(generation, Ordering::AcqRel);
    }
}

pub(super) struct Watchdog<'a> {
    job: &'a Job,
    activity: &'a Activity,
    // A `Read` the byte server has not answered yet.
    outstanding: &'a AtomicBool,
    ledger: Ledger,
    cpu_tick: Duration,
    // Audio accepted at the last check, and at the last CPU reading.
    audio_at_check: u64,
    audio_at_reading: u64,
    // The last CPU reading: when, and the helper's CPU time then. None until the first good one.
    reading: Option<(Instant, Duration)>,
    next_cpu_read: Instant,
    last_check: Instant,
    // A failed CPU reading was logged for this item.
    warned: bool,
}

impl<'a> Watchdog<'a> {
    pub(super) fn new(
        job: &'a Job,
        activity: &'a Activity,
        outstanding: &'a AtomicBool,
        limits: Limits,
        cpu_tick: Duration,
    ) -> Watchdog<'a> {
        let now = Instant::now();
        Watchdog {
            job,
            activity,
            outstanding,
            ledger: Ledger::new(limits),
            cpu_tick,
            audio_at_check: 0,
            audio_at_reading: 0,
            reading: None,
            next_cpu_read: now,
            last_check: now,
            warned: false,
        }
    }

    /// Counts a `Seek` main has just sent the helper.
    pub(super) fn seek_sent(&self, generation: u64) {
        self.activity.seek_sent(generation);
    }

    /// The fault the helper shows, if any. Called once per `WAIT_SLICE` while the helper lives.
    pub(super) fn check(&mut self) -> Option<Fault> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_check);
        self.last_check = now;
        self.ledger.seek(self.activity.seek.load(Ordering::Acquire));
        let audio_us = self.activity.audio_us.load(Ordering::Acquire);
        let audio = Duration::from_micros(audio_us - self.audio_at_check);
        self.audio_at_check = audio_us;
        let main_holds = self.outstanding.load(Ordering::Acquire)
            || self.activity.pushing.load(Ordering::Acquire);
        if let Some(fault) = self.ledger.tick(elapsed, main_holds, audio) {
            return Some(fault);
        }

        if now < self.next_cpu_read {
            return None;
        }
        self.next_cpu_read = now + self.cpu_tick;
        let cpu = match self.job.cpu_time() {
            Ok(cpu) => cpu,
            Err(e) => {
                if !std::mem::replace(&mut self.warned, true) {
                    eprintln!(
                        "warn: decode isolation: the helper's CPU time is unreadable ({e}); \
                         no spin check until it reads again"
                    );
                }
                // The next good reading is a new baseline, the credit kept: what the helper used
                // meanwhile is neither charged nor paid for.
                self.reading = None;
                return None;
            }
        };
        let audio = Duration::from_micros(audio_us - self.audio_at_reading);
        self.audio_at_reading = audio_us;
        let (at, before) = self.reading.replace((now, cpu))?;
        self.ledger
            .reading(now.duration_since(at), cpu.saturating_sub(before), audio)
    }
}
