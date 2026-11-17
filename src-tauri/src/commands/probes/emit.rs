/*
 * A synthetic event burst to the main window: fixed-size payloads at a fixed rate, each emit timed on
 * the sending side. The emitter runs on its own thread and schedules every emit from the burst's start
 * instant, so a late wake shortens the next wait instead of shifting every later emit. Each payload
 * carries its send instant, so the page can measure delivery jitter apart from pacing. One burst runs
 * at a time, and it ends at the first emit that fails or finds the main window gone.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Webview};
use tokio::sync::oneshot;

// -- Local Imports --
use super::main_only;
use crate::commands::plugins::MAIN_LABEL;

const EVENT: &str = "probe:burst";
const HZ: (u32, u32) = (1, 120);
const BYTES: (u32, u32) = (16, 65_536);
const SECS: (u32, u32) = (1, 30);
// The tail of each wait that is spun rather than slept.
const SPIN: Duration = Duration::from_millis(2);

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Burst {
    hz: u32,
    bytes: u32,
    secs: u32,
}

impl Burst {
    fn clamped(hz: u32, bytes: u32, secs: u32) -> Self {
        Self {
            hz: hz.clamp(HZ.0, HZ.1),
            bytes: bytes.clamp(BYTES.0, BYTES.1),
            secs: secs.clamp(SECS.0, SECS.1),
        }
    }
}

/// Holds the one-burst flag; dropping it frees the flag.
struct Lease(&'static AtomicBool);

impl Lease {
    fn take(flag: &'static AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Lease(flag))
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Serialize)]
struct Tick<'a> {
    seq: u32,
    /// Nanoseconds from the burst's start to this emit.
    sent_ns: u64,
    data: &'a str,
}

/// Sending-side time per emit, in microseconds.
#[derive(Debug, Serialize, PartialEq)]
pub struct BurstStats {
    count: u32,
    median_us: f64,
    p99_us: f64,
    max_us: f64,
}

/// Emits `probe:burst` to the main window `hz` times a second for `secs` seconds, each payload
/// `bytes` long, and returns the sending-side timings. Refused while another burst runs.
#[tauri::command]
pub async fn probe_emit_burst(
    hz: u32,
    bytes: u32,
    secs: u32,
    webview: Webview,
    app: AppHandle,
) -> Result<BurstStats, String> {
    main_only(webview.label())?;
    let lease = Lease::take(&RUNNING).ok_or("a burst is already running")?;
    let burst = Burst::clamped(hz, bytes, secs);
    let (tx, rx) = oneshot::channel();
    thread::Builder::new()
        .name("probe-burst".into())
        .spawn(move || {
            let _lease = lease;
            let _ = tx.send(run(&app, burst));
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "the burst thread ended early".to_string())
}

/// Emits to the main window while it exists. The first failed emit ends the burst.
fn run(app: &AppHandle, burst: Burst) -> BurstStats {
    pace(burst, |tick| {
        if app.get_webview_window(MAIN_LABEL).is_none() {
            return false;
        }
        app.emit_to(MAIN_LABEL, EVENT, tick).is_ok()
    })
}

/// Paces `burst` through `emit`, timing each call, and stops at the first call that returns false.
/// The stats cover the emits that succeeded.
fn pace(burst: Burst, mut emit: impl FnMut(Tick<'_>) -> bool) -> BurstStats {
    let data = "x".repeat(burst.bytes as usize);
    let period = Duration::from_secs(1) / burst.hz;
    let count = burst.hz * burst.secs;
    let mut took = Vec::with_capacity(count as usize);
    let start = Instant::now();
    for seq in 0..count {
        wait_until(start + period * seq);
        let sent = Instant::now();
        let tick = Tick {
            seq,
            sent_ns: (sent - start).as_nanos() as u64,
            data: &data,
        };
        if !emit(tick) {
            break;
        }
        took.push(sent.elapsed().as_secs_f64() * 1e6);
    }
    stats(&mut took)
}

fn wait_until(deadline: Instant) {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let left = deadline - now;
        if left > SPIN {
            thread::sleep(left - SPIN);
        } else {
            std::hint::spin_loop();
        }
    }
}

/// Count, median, 99th percentile (nearest rank) and maximum of the samples.
fn stats(samples: &mut [f64]) -> BurstStats {
    samples.sort_by(f64::total_cmp);
    let rank = |p: usize| -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let i = (p * samples.len()).div_ceil(100).max(1) - 1;
        samples[i]
    };
    BurstStats {
        count: samples.len() as u32,
        median_us: rank(50),
        p99_us: rank(99),
        max_us: samples.last().copied().unwrap_or(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_are_clamped() {
        assert_eq!(
            Burst::clamped(0, 0, 0),
            Burst {
                hz: 1,
                bytes: 16,
                secs: 1
            }
        );
        assert_eq!(
            Burst::clamped(1000, 1 << 20, 600),
            Burst {
                hz: 120,
                bytes: 65_536,
                secs: 30
            }
        );
        assert_eq!(
            Burst::clamped(30, 1024, 10),
            Burst {
                hz: 30,
                bytes: 1024,
                secs: 10
            }
        );
    }

    #[test]
    fn the_burst_stops_at_the_first_failed_emit() {
        let burst = Burst {
            hz: 120,
            bytes: 16,
            secs: 1,
        };
        let mut seqs = Vec::new();
        let stats = pace(burst, |tick| {
            seqs.push(tick.seq);
            tick.seq < 2
        });
        assert_eq!(seqs, [0, 1, 2]);
        assert_eq!(stats.count, 2);
    }

    #[test]
    fn one_burst_at_a_time() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let first = Lease::take(&FLAG).unwrap();
        assert!(Lease::take(&FLAG).is_none());
        drop(first);
        assert!(Lease::take(&FLAG).is_some());
    }

    #[test]
    fn stats_use_nearest_rank() {
        let mut samples: Vec<f64> = (1..=100).rev().map(f64::from).collect();
        assert_eq!(
            stats(&mut samples),
            BurstStats {
                count: 100,
                median_us: 50.0,
                p99_us: 99.0,
                max_us: 100.0
            }
        );
        let mut one = [7.0];
        let s = stats(&mut one);
        assert_eq!(
            (s.count, s.median_us, s.p99_us, s.max_us),
            (1, 7.0, 7.0, 7.0)
        );
        let empty = stats(&mut []);
        assert_eq!((empty.count, empty.max_us), (0, 0.0));
    }
}
