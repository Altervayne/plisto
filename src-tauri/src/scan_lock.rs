/*
 * The app-wide write lock every scan and batch write takes, so only one writer touches the index at a
 * time. It records who holds it: the user (a command the user started) or the background library
 * sync. A user taker preempts a background pass by raising its cancel flag and waiting for the
 * release; a background taker never preempts and simply retries later. The holder lives behind a
 * Mutex so taking and releasing are atomic; `scan_running` and `bg_active` mirror it for the readers
 * that only peek.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

// -- Local Imports --
use crate::state::AppState;

/// How long a user taker waits for a preempted background pass to let go.
const PREEMPT_WAIT: Duration = Duration::from_secs(5);

/// How often a waiting user taker checks for the release.
const PREEMPT_POLL: Duration = Duration::from_millis(20);

const BUSY: &str = "a scan is already running";

/// Who holds the scan lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    User,
    Background,
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
    }
}

/// Takes the scan lock for `holder`. A user taker preempts a background pass (see the module note)
/// and fails with the usual busy error when another user holds it or the pass does not let go in
/// time. A background taker fails at once when the lock is busy.
pub fn acquire_scan_lock(state: &AppState, holder: Holder) -> Result<ScanLockGuard<'_>, String> {
    acquire_with_wait(state, holder, PREEMPT_WAIT)
}

fn acquire_with_wait(
    state: &AppState,
    holder: Holder,
    wait: Duration,
) -> Result<ScanLockGuard<'_>, String> {
    let deadline = Instant::now() + wait;
    loop {
        match try_take(state, holder) {
            Ok(guard) => return Ok(guard),
            Err(Some(Holder::Background)) if holder == Holder::User => {
                state.bg_cancel.store(true, Ordering::SeqCst);
                if Instant::now() >= deadline {
                    return Err(BUSY.to_string());
                }
                std::thread::sleep(PREEMPT_POLL);
            }
            Err(_) => return Err(BUSY.to_string()),
        }
    }
}

/// Takes the lock when it is free, else reports who holds it.
fn try_take(state: &AppState, holder: Holder) -> Result<ScanLockGuard<'_>, Option<Holder>> {
    let mut current = state.scan_holder.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(taken) = *current {
        return Err(Some(taken));
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
}
