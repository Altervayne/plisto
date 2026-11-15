/*
 * What a test is told of one helper: how many of the item's serving threads still run, duplicates
 * of the helper's pipe ends that stay open past its death, as a handle leaked into another process
 * would, and the helper's peak committed memory and CPU time.
 */

// -- Library Imports --
use std::cell::RefCell;
use std::os::windows::io::OwnedHandle;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

// -- Local Imports --
use crate::proc::contained::{self, Contained};
use crate::proc::job::Job;

#[derive(Default)]
pub(super) struct Probe {
    /// Counts the item's writer, byte server and pump while they run.
    pub(super) threads: Option<Arc<AtomicUsize>>,
    /// Receives duplicates of the helper's stdin read end and stdout write end.
    pub(super) leaks: Option<Sender<Vec<OwnedHandle>>>,
    /// Receives the most memory the helper committed, once the item's end is decided.
    pub(super) peak: Option<Sender<usize>>,
    /// Receives the helper's CPU time at its Ready, then once the item's end is decided.
    pub(super) cpu: Option<Sender<Duration>>,
}

thread_local! {
    // The tally of the item whose bridge thread this is.
    static THREADS: RefCell<Option<Arc<AtomicUsize>>> = const { RefCell::new(None) };
}

impl Probe {
    /// Called on the bridge thread before the launch.
    pub(super) fn enter(&self) {
        THREADS.set(self.threads.clone());
        if self.leaks.is_some() {
            contained::leak_pipes_on_this_thread();
        }
    }

    pub(super) fn launched(&self, process: &mut Contained, job: &Job) {
        if let Some(leaks) = &self.leaks {
            let _ = leaks.send(std::mem::take(&mut process.leaked));
        }
        self.send_cpu(job);
    }

    pub(super) fn ended(&self, job: &Job) {
        if let Some(peak) = &self.peak {
            let _ = peak.send(job.peak_process_memory().unwrap_or(0));
        }
        self.send_cpu(job);
    }

    fn send_cpu(&self, job: &Job) {
        if let Some(cpu) = &self.cpu {
            let _ = cpu.send(job.cpu_time().unwrap_or_default());
        }
    }
}

/// A thread's live count, given back when the thread ends, a panic included.
struct Token(Option<Arc<AtomicUsize>>);

impl Drop for Token {
    fn drop(&mut self) {
        if let Some(threads) = &self.0 {
            threads.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// `body`, counted in the bridge thread's tally from now until it returns.
pub(super) fn counted(body: impl FnOnce() + Send + 'static) -> impl FnOnce() + Send + 'static {
    let threads = THREADS.with_borrow(Clone::clone);
    if let Some(threads) = &threads {
        threads.fetch_add(1, Ordering::AcqRel);
    }
    let token = Token(threads);
    move || {
        let _token = token;
        body()
    }
}
