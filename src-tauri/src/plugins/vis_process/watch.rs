/*
 * The renderers the watch holds handles to: which a later list confirmed, which it tainted, the
 * visualizer hosts each served, and each one's busy run. Also when the watch thread may stop.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::time::Instant;

// -- Local Imports --
use super::{end_allowed, Interval, Listed, Load, Refusal};

/// Ticks in a row with nothing tracked and no visualizer frame listed before the thread stops. A
/// frame's process is listed only once its document commits, a moment after the request that
/// woke the thread.
pub const IDLE_TICKS: u32 = 5;

/// The idle count after one tick. `listed_empty` is None when the list failed: with renderers
/// tracked that tick is skipped, keeping the count and every handle, and with none tracked it
/// counts as idle, so a webview that never answers does not keep the thread alive.
pub fn idle_after(idle: u32, woken: bool, listed_empty: Option<bool>, tracking: bool) -> u32 {
    match listed_empty {
        _ if woken => 0,
        Some(false) => 0,
        Some(true) => idle + 1,
        None if tracking => idle,
        None => idle + 1,
    }
}

/// One renderer the watch holds a handle to.
#[derive(Debug)]
struct Tracked<H> {
    pid: u32,
    created: u64,
    handle: H,
    // The count of valid shown reports when tracking began.
    reports_at_track: u64,
    // Every visualizer host it was listed serving while tracked.
    labels: BTreeSet<String>,
    // A list taken after the handle opened showed it serving visualizer frames only.
    confirmed: bool,
    // A list showed it serving something else; it is never sampled or ended again.
    tainted: bool,
    load: Load,
    last: Option<(u64, Instant)>,
}

/// The renderers serving visualizer frames, each held by an open handle of type `H`.
#[derive(Debug)]
pub struct Watch<H> {
    tracked: Vec<Tracked<H>>,
}

impl<H> Default for Watch<H> {
    fn default() -> Self {
        Self {
            tracked: Vec::new(),
        }
    }
}

impl<H> Watch<H> {
    /// Applies a fresh list: drops a process it no longer shows, confirms one serving visualizer
    /// frames only, and taints for good one serving anything else. Returns the pids of renderers
    /// serving visualizer frames only that are not tracked yet, to open before the next list.
    pub fn apply(&mut self, list: &[Listed]) -> Vec<u32> {
        self.tracked.retain(|t| list.iter().any(|p| p.pid == t.pid));
        for t in &mut self.tracked {
            let Some(p) = list.iter().find(|p| p.pid == t.pid) else {
                continue;
            };
            if p.vis_only() {
                t.confirmed = true;
                t.labels.extend(p.vis_labels());
            } else if !p.renderer || !p.frames.is_empty() {
                // A mixed process is never ended, even when its other frames are about:blank.
                t.tainted = true;
                t.load = Load::default();
            }
        }
        list.iter()
            .filter(|p| p.vis_only() && !self.tracked.iter().any(|t| t.pid == p.pid))
            .map(|p| p.pid)
            .collect()
    }

    /// Starts tracking `pid` by a handle opened after the list that named it, with `reports` the
    /// count of valid shown reports so far.
    pub fn add(&mut self, pid: u32, created: u64, handle: H, reports: u64) {
        if self.tracked.iter().any(|t| t.pid == pid) {
            return;
        }
        self.tracked.push(Tracked {
            pid,
            created,
            handle,
            reports_at_track: reports,
            labels: BTreeSet::new(),
            confirmed: false,
            tainted: false,
            load: Load::default(),
            last: None,
        });
    }

    /// `(pid, creation time)` of every untainted process a list confirmed.
    pub fn seen(&self) -> Vec<(u32, u64)> {
        self.tracked
            .iter()
            .filter(|t| t.confirmed && !t.tainted)
            .map(|t| (t.pid, t.created))
            .collect()
    }

    pub fn is_tracking(&self) -> bool {
        !self.tracked.is_empty()
    }

    /// Feeds every confirmed, untainted process the CPU total `read` returns for it at `at`. An
    /// interval in which one of its visualizers was shown, the shown set was unknown, or no report
    /// had arrived since tracking began restarts its run. Returns the pids whose busy run is
    /// complete; their run restarts. A failed read restarts the run and the next reading.
    pub fn sample(
        &mut self,
        at: Instant,
        shown: &Interval,
        mut read: impl FnMut(&H) -> Option<u64>,
    ) -> Vec<u32> {
        let mut due = Vec::new();
        for t in self.tracked.iter_mut().filter(|t| t.confirmed && !t.tainted) {
            let Some(cpu) = read(&t.handle) else {
                t.load = Load::default();
                t.last = None;
                continue;
            };
            if let Some((before, then)) = t.last {
                let wall = at.saturating_duration_since(then);
                let held = shown.clear_for(&t.labels, t.reports_at_track).is_err();
                if t.load.observe(cpu.saturating_sub(before), wall, held) {
                    t.load = Load::default();
                    due.push(t.pid);
                }
            }
            t.last = Some((cpu, at));
        }
        due
    }

    /// The handle to end `pid` through, judged on a list taken now and the shown state read just
    /// before acting. The hosts checked against the shown set are every one it was listed serving,
    /// this list included.
    pub fn end_check(&self, pid: u32, list: &[Listed], shown: &Interval) -> Result<&H, Refusal> {
        let t = self
            .tracked
            .iter()
            .find(|t| t.pid == pid)
            .ok_or(Refusal::NotTracked)?;
        if !t.confirmed || t.tainted {
            return Err(Refusal::NotConfirmed);
        }
        end_allowed(list, &self.seen(), pid, t.created)?;
        let mut labels = t.labels.clone();
        if let Some(p) = list.iter().find(|p| p.pid == pid) {
            labels.extend(p.vis_labels());
        }
        shown.clear_for(&labels, t.reports_at_track)?;
        Ok(&t.handle)
    }

    /// Whether nothing is tracked and the list shows no frame on a visualizer host.
    pub fn idle(&self, list: &[Listed]) -> bool {
        self.tracked.is_empty() && !list.iter().any(Listed::serves_vis)
    }
}

#[cfg(test)]
mod tests;
