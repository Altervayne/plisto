/*
 * The shown visualizer hosts as the front end reports them. The set starts unknown and turns
 * unknown again on a rejected report, so a missing or bad report never reads as "nothing shown".
 * Each valid report is counted, which tells whether the reporter has spoken since a process was
 * first tracked.
 */

// -- Library Imports --
use std::collections::BTreeSet;

// -- Local Imports --
use super::Refusal;
use crate::plugins::frame_host::vis_host::parse_vis_url;

const VIS_SUFFIX: &str = ".invalid";

/// The visualizer host label of a host name `pv-<hash>.invalid`, or None for any other name.
pub fn shown_label(host: &str) -> Option<String> {
    let label = host.strip_suffix(VIS_SUFFIX)?;
    let url = format!("https://{host}/");
    match parse_vis_url(&url) {
        Some((parsed, "/")) if parsed == label => Some(label.to_string()),
        _ => None,
    }
}

/// The last valid report, every host shown at any moment since the last sample, and the number of
/// valid reports so far.
#[derive(Debug, Default)]
pub struct Shown {
    current: Option<BTreeSet<String>>,
    since_sample: BTreeSet<String>,
    reports: u64,
}

impl Shown {
    pub const fn new() -> Self {
        Self {
            current: None,
            since_sample: BTreeSet::new(),
            reports: 0,
        }
    }

    /// Records a valid report: the full set of shown hosts.
    pub fn report(&mut self, labels: BTreeSet<String>) {
        self.since_sample.extend(labels.iter().cloned());
        self.current = Some(labels);
        self.reports += 1;
    }

    /// Records a rejected report: the shown set is unknown until the next valid one.
    pub fn reject(&mut self) {
        self.current = None;
    }

    /// How many valid reports have arrived.
    pub fn reports(&self) -> u64 {
        self.reports
    }

    /// The state for the interval since the previous call, which then starts a new interval. A host
    /// shown and hidden between two samples still counts as shown in that interval.
    pub fn take_interval(&mut self) -> Interval {
        let interval = self.peek();
        self.since_sample = self.current.clone().unwrap_or_default();
        interval
    }

    /// The state for the interval so far, leaving it open.
    pub fn peek(&self) -> Interval {
        let mut labels = self.since_sample.clone();
        labels.extend(self.current.iter().flatten().cloned());
        Interval {
            labels,
            known: self.current.is_some(),
            reports: self.reports,
        }
    }
}

/// What was shown over one interval.
#[derive(Debug, Clone)]
pub struct Interval {
    labels: BTreeSet<String>,
    known: bool,
    reports: u64,
}

impl Interval {
    /// Whether a process serving `labels`, first tracked when `reports_at_track` reports had
    /// arrived, is known to have had none of them shown over the interval.
    pub fn clear_for(
        &self,
        labels: &BTreeSet<String>,
        reports_at_track: u64,
    ) -> Result<(), Refusal> {
        if !self.known {
            return Err(Refusal::ShownUnknown);
        }
        if self.reports <= reports_at_track {
            return Err(Refusal::NoReportSinceTracked);
        }
        if !self.labels.is_disjoint(labels) {
            return Err(Refusal::Shown);
        }
        Ok(())
    }
}
