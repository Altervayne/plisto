/*
 * Waits on a helper's anonymous pipes that never outlast the helper. A pipe end can leak into
 * another process through a std spawn that does not take the spawn lock, and a leaked end keeps the
 * pipe open after the helper is gone: a blocking read would then never see the end of the pipe, and
 * a blocking write would never fail. So reads look at what waits in the pipe before they read, and a
 * write that must stop is cancelled from another thread.
 */

// -- Library Imports --
use std::fs::File;
use std::os::windows::io::AsRawHandle;
use std::thread::JoinHandle;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Pipes::PeekNamedPipe;
use windows::Win32::System::IO::{CancelIoEx, CancelSynchronousIo};

/// The bytes waiting in the pipe `read_end`, or None once its write end is closed and nothing is
/// left to read.
pub fn waiting(read_end: &File) -> Option<u32> {
    let mut waiting = 0u32;
    // SAFETY: the pipe handle is open while `read_end` lives, and `waiting` is a live u32.
    let peeked = unsafe {
        PeekNamedPipe(
            HANDLE(read_end.as_raw_handle()),
            None,
            0,
            None,
            Some(&mut waiting),
            None,
        )
    };
    peeked.ok().map(|()| waiting)
}

/// Cancels the blocking read or write `thread` is in on `pipe`, if any: it fails as if the pipe
/// broke. `pipe` is a handle to the same pipe end as the thread's own, so the second attempt, by
/// pipe rather than by thread, reaches the write even where the first did not. A thread that is not
/// blocked is not affected.
pub fn cancel_blocked_io<T>(thread: &JoinHandle<T>, pipe: &File) {
    // SAFETY: the thread handle is open while `thread` lives, with the access std created it with,
    // which includes the terminate right the call needs.
    let _ = unsafe { CancelSynchronousIo(HANDLE(thread.as_raw_handle())) };
    // SAFETY: the pipe handle is open while `pipe` lives; no OVERLAPPED is named, so every request
    // on the pipe end is cancelled.
    let _ = unsafe { CancelIoEx(HANDLE(pipe.as_raw_handle()), None) };
}
