/*
 * A counting global allocator for the test build. It forwards every call to the system allocator
 * and, on a thread that asked to be watched, records the largest single allocation requested. Only
 * a watched thread pays more than one thread-local read, so the rest of the test suite runs as
 * before. A size is recorded before the system allocator sees it, so the record holds even for a
 * request the system refuses.
 */

// -- Library Imports --
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;

thread_local! {
    static WATCH: Cell<Option<&'static AtomicUsize>> = const { Cell::new(None) };
}

fn note(size: usize) {
    let _ = WATCH.try_with(|w| {
        if let Some(largest) = w.get() {
            largest.fetch_max(size, Ordering::Relaxed);
        }
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note(layout.size());
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note(layout.size());
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note(new_size);
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Records the largest allocation this thread requests from now on into `largest`.
pub fn watch_this_thread(largest: &'static AtomicUsize) {
    WATCH.with(|w| w.set(Some(largest)));
}

/// A fresh record for one test. Leaked: a test lives as long as the process.
pub fn new_record() -> &'static AtomicUsize {
    Box::leak(Box::new(AtomicUsize::new(0)))
}
