/*
 * The process's global allocator: the system allocator, plus an exit on allocation failure once the
 * decode helper arms it. A helper's job caps the memory it may commit, so an allocation past the cap
 * returns null; the helper then terminates itself with `EXIT_MEMORY` instead of aborting, which
 * gives the main process a distinct exit code and leaves no crash report behind. Unarmed, as in the
 * app, a failure takes the standard path.
 *
 * The test build also counts: on a thread that asked to be watched, it records the largest single
 * allocation requested, before the system allocator sees it, so the record holds even for a request
 * the system refuses. Only a watched thread pays more than one thread-local read.
 */

// -- Library Imports --
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};

#[cfg(test)]
use std::cell::Cell;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;

/// The exit code of a helper whose allocation failed. Neither the job's kill nor a crash produces it.
pub const EXIT_MEMORY: u32 = 0x0D0C_0001;

static ARMED: AtomicBool = AtomicBool::new(false);

/// Makes every later allocation failure end the process with `EXIT_MEMORY`. Called only in the
/// decode helper.
pub fn arm() {
    ARMED.store(true, Ordering::Release);
}

struct HelperAlloc;

// A null result from the system allocator, seen before Rust's allocation-failure handler runs.
fn checked(ptr: *mut u8) -> *mut u8 {
    if ptr.is_null() && ARMED.load(Ordering::Acquire) {
        // SAFETY: a pseudo-handle to this process, which carries terminate rights. On success the
        // call does not return.
        let _ = unsafe { TerminateProcess(GetCurrentProcess(), EXIT_MEMORY) };
    }
    ptr
}

unsafe impl GlobalAlloc for HelperAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        #[cfg(test)]
        note(layout.size());
        checked(System.alloc(layout))
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        #[cfg(test)]
        note(layout.size());
        checked(System.alloc_zeroed(layout))
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        #[cfg(test)]
        note(new_size);
        checked(System.realloc(ptr, layout, new_size))
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: HelperAlloc = HelperAlloc;

#[cfg(test)]
thread_local! {
    static WATCH: Cell<Option<&'static AtomicUsize>> = const { Cell::new(None) };
}

#[cfg(test)]
fn note(size: usize) {
    let _ = WATCH.try_with(|w| {
        if let Some(largest) = w.get() {
            largest.fetch_max(size, Ordering::Relaxed);
        }
    });
}

/// Records the largest allocation this thread requests from now on into `largest`.
#[cfg(test)]
pub fn watch_this_thread(largest: &'static AtomicUsize) {
    WATCH.with(|w| w.set(Some(largest)));
}

/// A fresh record for one test. Leaked: a test lives as long as the process.
#[cfg(test)]
pub fn new_record() -> &'static AtomicUsize {
    Box::leak(Box::new(AtomicUsize::new(0)))
}
