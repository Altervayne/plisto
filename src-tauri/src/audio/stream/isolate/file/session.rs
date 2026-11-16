/*
 * What the app session knows of opened files beyond any one open: the files whose helper failed on
 * their bytes, and whether a helper can be set up on this machine.
 *
 * A faulted file is never decoded in-process. When a helper cannot be set up, opened files decode
 * in-process for `FILE_SETUP_RETRY_MS`, so a machine without the container does not pay a failed
 * launch on every file; the next opened file after that tries a helper again. The session says once
 * that opened files decode in-process.
 */

// -- Library Imports --
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

// -- Local Imports --
use super::FILE_OPEN_MS;

/// How long opened files decode in-process after a helper could not be set up.
pub const FILE_SETUP_RETRY_MS: u64 = 300_000;

/// The most faulted files remembered; the oldest is forgotten first.
const FAULTED_MAX: usize = 256;

static SESSION: LazyLock<Arc<FileSession>> =
    LazyLock::new(|| Arc::new(FileSession::new(Duration::from_millis(FILE_OPEN_MS))));

#[cfg(test)]
thread_local! {
    static TEST_SESSION: std::cell::RefCell<Option<Arc<FileSession>>> =
        const { std::cell::RefCell::new(None) };
}

/// The session the opened files of this thread belong to.
pub fn session() -> Arc<FileSession> {
    #[cfg(test)]
    if let Some(session) = TEST_SESSION.with_borrow(Clone::clone) {
        return session;
    }
    Arc::clone(&SESSION)
}

/// Gives this thread a session of its own, with `open_wait` in place of `FILE_OPEN_MS`.
#[cfg(test)]
pub(crate) fn use_test_session(open_wait: Duration) -> Arc<FileSession> {
    let session = Arc::new(FileSession::new(open_wait));
    TEST_SESSION.set(Some(Arc::clone(&session)));
    session
}

/// The key a file is remembered under: its real path, so two opens of one file match.
pub fn file_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub struct FileSession {
    // Keys of the files whose helper faulted, oldest first.
    faulted: Mutex<VecDeque<PathBuf>>,
    // Until when no helper is launched for an opened file.
    setup_down_until: Mutex<Option<Instant>>,
    warned: AtomicBool,
    /// How long a helper has, once it runs, for its first audio or a seek's.
    pub(super) open_wait: Duration,
    /// Makes every launch fail its setup, as a machine without the container does.
    #[cfg(test)]
    pub(crate) fail_setup: AtomicBool,
    #[cfg(test)]
    launches: std::sync::atomic::AtomicUsize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl FileSession {
    fn new(open_wait: Duration) -> Self {
        Self {
            faulted: Mutex::default(),
            setup_down_until: Mutex::default(),
            warned: AtomicBool::new(false),
            open_wait,
            #[cfg(test)]
            fail_setup: AtomicBool::new(false),
            #[cfg(test)]
            launches: Default::default(),
        }
    }

    /// Whether a helper failed on the file under `key` in this session.
    pub fn is_faulted(&self, key: &Path) -> bool {
        lock(&self.faulted).iter().any(|k| k == key)
    }

    pub(in crate::audio::stream::isolate) fn mark_faulted(&self, key: PathBuf) {
        let mut faulted = lock(&self.faulted);
        if faulted.contains(&key) {
            return;
        }
        if faulted.len() == FAULTED_MAX {
            faulted.pop_front();
        }
        faulted.push_back(key);
    }

    /// Whether helpers are not tried, after one could not be set up.
    pub(in crate::audio::stream::isolate) fn setup_down(&self) -> bool {
        lock(&self.setup_down_until).is_some_and(|until| Instant::now() < until)
    }

    /// A helper could not be set up: none is tried for `FILE_SETUP_RETRY_MS`.
    pub(in crate::audio::stream::isolate) fn setup_failed(&self, error: &str) {
        let retry = Instant::now() + Duration::from_millis(FILE_SETUP_RETRY_MS);
        *lock(&self.setup_down_until) = Some(retry);
        if !self.warned.swap(true, Ordering::AcqRel) {
            eprintln!("{}", unavailable_line(error));
        }
    }

    /// Counts one helper launch.
    pub(in crate::audio::stream::isolate) fn launching(&self) {
        #[cfg(test)]
        self.launches.fetch_add(1, Ordering::AcqRel);
    }

    /// Ends the wait after a setup failure, as if `FILE_SETUP_RETRY_MS` had passed.
    #[cfg(test)]
    pub(crate) fn end_setup_retry(&self) {
        *lock(&self.setup_down_until) = Some(Instant::now());
    }

    /// The helpers launched for opened files in this session.
    #[cfg(test)]
    pub(crate) fn launches(&self) -> usize {
        self.launches.load(Ordering::Acquire)
    }

    /// Whether the session said that opened files decode in-process.
    #[cfg(test)]
    pub(crate) fn warned(&self) -> bool {
        self.warned.load(Ordering::Acquire)
    }
}

pub(super) fn unavailable_line(error: &str) -> String {
    format!("warn: decode isolation unavailable ({error}); opened files decode in-process")
}
