/*
 * The app-wide write lock every scan and batch write takes, so only one writer touches the index at a
 * time. It records who holds it: the user (a command the user started), a write to a music file, or
 * the background library sync. The order is User over FileWrite over Background. A taker preempts a
 * lower holder by raising that holder's flag and waiting for the release: `bg_cancel` stops a
 * background pass, `file_write_yield` asks a file write to let go between files. A background taker
 * never preempts and simply retries later. While the yield flag is up a file-write taker stays out,
 * so the waiting user gets the lock first. The holder lives behind a Mutex so taking and releasing
 * are atomic; `scan_running` and `bg_active` mirror it for the readers that only peek.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

// -- Local Imports --
use crate::loudness::LoudnessCmd;
use crate::state::AppState;

/// How long a preempting taker waits for the lower holder to let go.
const PREEMPT_WAIT: Duration = Duration::from_secs(5);

/// How often a waiting taker checks for the release.
const PREEMPT_POLL: Duration = Duration::from_millis(20);

const BUSY: &str = "a scan is already running";
/// The error a command gets while a write to a music file is running.
pub const WRITE_BUSY: &str = "a file write is running";

/// Who holds the scan lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    User,
    // Unused until a command writes a music file in place.
    #[allow(dead_code)]
    FileWrite,
    Background,
}

impl Holder {
    /// The error a refused taker gets while this holder has the lock.
    fn busy(self) -> &'static str {
        match self {
            Holder::FileWrite => WRITE_BUSY,
            Holder::User | Holder::Background => BUSY,
        }
    }

    fn preempts(self, held: Holder) -> bool {
        matches!(
            (self, held),
            (Holder::User, Holder::FileWrite | Holder::Background)
                | (Holder::FileWrite, Holder::Background)
        )
    }
}

/// True while a scan the user started holds the lock; a background pass or a file write is not one.
pub fn user_scan_running(state: &AppState) -> bool {
    let holder = state.scan_holder.lock().unwrap_or_else(|e| e.into_inner());
    *holder == Some(Holder::User)
}

/// The held scan lock. Dropping it releases the lock, whatever path the holder leaves by.
pub struct ScanLockGuard<'a> {
    state: &'a AppState,
}

impl Drop for ScanLockGuard<'_> {
    fn drop(&mut self) {
        let mut holder = self
            .state
            .scan_holder
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *holder = None;
        self.state.scan_running.store(false, Ordering::SeqCst);
        self.state.bg_active.store(false, Ordering::SeqCst);
        // Every scan and batch write ends here, so the loudness worker re-sweeps what it changed.
        let _ = self.state.loudness.send(LoudnessCmd::Kick);
    }
}

/// Takes the scan lock for `holder`. A taker preempts a lower holder (see the module note) and fails
/// with the holder's busy error when an equal or higher one holds it or the lower one does not let go
/// in time. A background taker fails at once when the lock is busy.
pub fn acquire_scan_lock(state: &AppState, holder: Holder) -> Result<ScanLockGuard<'_>, String> {
    acquire_with_wait(state, holder, PREEMPT_WAIT)
}

fn acquire_with_wait(
    state: &AppState,
    holder: Holder,
    wait: Duration,
) -> Result<ScanLockGuard<'_>, String> {
    let deadline = Instant::now() + wait;
    let mut raised_yield = false;
    let taken = loop {
        match try_take(state, holder) {
            Ok(guard) => break Ok(guard),
            Err(Some(held)) if holder.preempts(held) => {
                if held == Holder::FileWrite {
                    state.file_write_yield.store(true, Ordering::SeqCst);
                    raised_yield = true;
                } else {
                    state.bg_cancel.store(true, Ordering::SeqCst);
                }
                if Instant::now() >= deadline {
                    break Err(held.busy().to_string());
                }
                std::thread::sleep(PREEMPT_POLL);
            }
            Err(held) => break Err(held.map_or(BUSY, Holder::busy).to_string()),
        }
    };
    if raised_yield {
        state.file_write_yield.store(false, Ordering::SeqCst);
    }
    taken
}

/// Takes the lock when it is free, else reports who holds it. None means the lock is free but a user
/// taker waits for it, which only a file-write taker defers to.
fn try_take(state: &AppState, holder: Holder) -> Result<ScanLockGuard<'_>, Option<Holder>> {
    let mut current = state.scan_holder.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(taken) = *current {
        return Err(Some(taken));
    }
    if holder == Holder::FileWrite && state.file_write_yield.load(Ordering::SeqCst) {
        return Err(None);
    }
    *current = Some(holder);
    // bg_active first, so a reader that sees the lock taken already sees who took it.
    state
        .bg_active
        .store(holder == Holder::Background, Ordering::SeqCst);
    state.scan_running.store(true, Ordering::SeqCst);
    Ok(ScanLockGuard { state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn state() -> AppState {
        AppState::for_test(crate::db::open_in_memory().unwrap(), PathBuf::new())
    }

    #[test]
    fn a_user_holder_preempts_a_background_holder() {
        let state = state();
        let bg = acquire_scan_lock(&state, Holder::Background).unwrap();
        assert!(state.bg_active.load(Ordering::SeqCst));

        let shared = &state;
        std::thread::scope(|s| {
            // The background pass notices its cancel flag and lets go.
            s.spawn(move || {
                while !shared.bg_cancel.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                drop(bg);
            });
            let user = acquire_scan_lock(&state, Holder::User).expect("the user takes over");
            assert!(state.scan_running.load(Ordering::SeqCst));
            assert!(!state.bg_active.load(Ordering::SeqCst));
            drop(user);
        });
        assert!(!state.scan_running.load(Ordering::SeqCst));
    }

    #[test]
    fn a_user_holder_gives_up_when_the_background_pass_hangs_on() {
        let state = state();
        let _bg = acquire_scan_lock(&state, Holder::Background).unwrap();
        let taken = acquire_with_wait(&state, Holder::User, Duration::from_millis(50));
        assert_eq!(taken.err().as_deref(), Some(BUSY));
        assert!(state.bg_cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn a_background_holder_never_preempts() {
        let state = state();
        let _user = acquire_scan_lock(&state, Holder::User).unwrap();
        assert!(acquire_scan_lock(&state, Holder::Background).is_err());
        assert!(!state.bg_cancel.load(Ordering::SeqCst));
        assert!(!state.bg_active.load(Ordering::SeqCst));
    }

    #[test]
    fn a_second_user_holder_is_rejected() {
        let state = state();
        let _user = acquire_scan_lock(&state, Holder::User).unwrap();
        let second = acquire_scan_lock(&state, Holder::User);
        assert_eq!(second.err().as_deref(), Some(BUSY));
    }

    #[test]
    fn dropping_the_guard_frees_the_lock() {
        let state = state();
        drop(acquire_scan_lock(&state, Holder::User).unwrap());
        assert!(acquire_scan_lock(&state, Holder::Background).is_ok());
    }

    #[test]
    fn the_busy_error_names_the_holder() {
        let state = state();
        let user = acquire_scan_lock(&state, Holder::User).unwrap();
        let refused = acquire_scan_lock(&state, Holder::FileWrite);
        assert_eq!(refused.err().as_deref(), Some(BUSY));
        drop(user);

        let _write = acquire_scan_lock(&state, Holder::FileWrite).unwrap();
        let second = acquire_scan_lock(&state, Holder::FileWrite);
        assert_eq!(second.err().as_deref(), Some(WRITE_BUSY));
        let user = acquire_with_wait(&state, Holder::User, Duration::from_millis(50));
        assert_eq!(user.err().as_deref(), Some(WRITE_BUSY));
    }

    #[test]
    fn no_scan_runs_while_a_file_write_holds_the_lock() {
        let state = state();
        let _write = acquire_scan_lock(&state, Holder::FileWrite).unwrap();
        assert!(state.scan_running.load(Ordering::SeqCst));
        assert!(!state.bg_active.load(Ordering::SeqCst));

        let background = acquire_scan_lock(&state, Holder::Background);
        assert_eq!(background.err().as_deref(), Some(WRITE_BUSY));
        assert!(
            !state.file_write_yield.load(Ordering::SeqCst),
            "a background taker never asks a write to yield"
        );
        let user = acquire_with_wait(&state, Holder::User, Duration::from_millis(50));
        assert!(user.is_err(), "a holder that never yields keeps the lock");
        assert!(
            !state.file_write_yield.load(Ordering::SeqCst),
            "a taker that gives up lowers the yield flag"
        );
        assert!(!state.bg_cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn a_file_write_preempts_a_background_pass() {
        let state = state();
        let bg = acquire_scan_lock(&state, Holder::Background).unwrap();
        let shared = &state;
        std::thread::scope(|s| {
            s.spawn(move || {
                while !shared.bg_cancel.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                drop(bg);
            });
            let write = acquire_scan_lock(&state, Holder::FileWrite).expect("the write takes over");
            assert!(!state.bg_active.load(Ordering::SeqCst));
            drop(write);
        });
    }

    #[test]
    fn a_user_taker_gets_the_lock_between_files_and_the_write_resumes() {
        const FILES: u32 = 40;
        let state = state();
        let done = std::sync::atomic::AtomicU32::new(0);
        let shared = &state;
        let counter = &done;
        let started = &std::sync::Barrier::new(2);
        std::thread::scope(|s| {
            s.spawn(move || {
                let mut guard = Some(acquire_scan_lock(shared, Holder::FileWrite).unwrap());
                started.wait();
                for _ in 0..FILES {
                    if guard.is_none() {
                        // Wait out the user command, then take the lock again.
                        guard = loop {
                            match acquire_scan_lock(shared, Holder::FileWrite) {
                                Ok(g) => break Some(g),
                                Err(_) => std::thread::sleep(Duration::from_millis(5)),
                            }
                        };
                    }
                    std::thread::sleep(Duration::from_millis(5));
                    counter.fetch_add(1, Ordering::SeqCst);
                    if shared.file_write_yield.load(Ordering::SeqCst) {
                        guard = None;
                    }
                }
            });
            started.wait();
            let user = acquire_scan_lock(&state, Holder::User).expect("the write lets go");
            assert!(!state.file_write_yield.load(Ordering::SeqCst));
            let at_take = done.load(Ordering::SeqCst);
            assert!(at_take < FILES, "the user did not wait for the whole batch");
            std::thread::sleep(Duration::from_millis(30));
            assert_eq!(done.load(Ordering::SeqCst), at_take, "no file runs under the user");
            drop(user);
        });
        assert_eq!(done.load(Ordering::SeqCst), FILES, "the write resumed and finished");
        assert!(!state.scan_running.load(Ordering::SeqCst));
    }
}
