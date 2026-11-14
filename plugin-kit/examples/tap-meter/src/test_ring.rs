/*
 * A tap writer for tests: creates a named mapping in layout v1 and writes samples and segment records
 * the way Plisto's engine does, so the reader and the whole program can be tested without Plisto.
 * Shared by the unit tests and the process tests.
 */

// -- Library Imports --
use std::ptr;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};

const CAPACITY: usize = 1 << 20;
const SEGMENTS: usize = 64;
const SAMPLES_OFFSET: usize = 4096;
const MAP_BYTES: usize = SAMPLES_OFFSET + CAPACITY * 4;

static NEXT: AtomicUsize = AtomicUsize::new(0);

pub struct TestRing {
    name: String,
    handle: HANDLE,
    base: *mut u8,
    cursor: u64,
    records: u64,
}

impl TestRing {
    /// A zeroed mapping under a name no other test uses, with the v1 header written.
    pub fn create() -> Self {
        let name = format!(
            r"Local\tap-meter-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a paging-file mapping with default security and a NUL-terminated name.
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                ptr::null(),
                PAGE_READWRITE,
                0,
                MAP_BYTES as u32,
                wide.as_ptr(),
            )
        };
        assert!(!handle.is_null(), "creates the mapping");
        // SAFETY: a valid mapping handle of MAP_BYTES.
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, MAP_BYTES) };
        assert!(!view.Value.is_null(), "maps the view");
        let ring = Self {
            name,
            handle,
            base: view.Value.cast(),
            cursor: 0,
            records: 0,
        };
        ring.u32_at(0)
            .store(u32::from_le_bytes(*b"PTAP"), Ordering::Relaxed);
        ring.u32_at(4).store(1, Ordering::Relaxed);
        ring.u32_at(8).store(CAPACITY as u32, Ordering::Relaxed);
        ring.u32_at(12).store(SEGMENTS as u32, Ordering::Relaxed);
        ring
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn u32_at(&self, offset: usize) -> &AtomicU32 {
        // SAFETY: inside the page-aligned view, 4-aligned, alive as long as self.
        unsafe { &*self.base.add(offset).cast::<AtomicU32>() }
    }

    fn u64_at(&self, offset: usize) -> &AtomicU64 {
        // SAFETY: as above, 8-aligned.
        unsafe { &*self.base.add(offset).cast::<AtomicU64>() }
    }

    /// Stores one sample after the last. It is not visible to readers until `publish`.
    pub fn push(&mut self, sample: f32) {
        let at = SAMPLES_OFFSET + (self.cursor as usize & (CAPACITY - 1)) * 4;
        self.u32_at(at).store(sample.to_bits(), Ordering::Relaxed);
        self.cursor += 1;
    }

    /// Publishes the write cursor.
    pub fn publish(&self) {
        self.u64_at(16).store(self.cursor, Ordering::Release);
    }

    /// Publishes a segment record that starts at the next sample.
    pub fn record(&mut self, epoch: u32, rate: u32, channels: u32) {
        let at = 32 + (self.records as usize & (SEGMENTS - 1)) * 24;
        self.u64_at(at).store(self.cursor, Ordering::Relaxed);
        self.u32_at(at + 8).store(epoch, Ordering::Relaxed);
        self.u32_at(at + 12).store(rate, Ordering::Relaxed);
        self.u32_at(at + 16).store(channels, Ordering::Relaxed);
        self.records += 1;
        self.u64_at(24).store(self.records, Ordering::Release);
    }
}

impl Drop for TestRing {
    fn drop(&mut self) {
        // SAFETY: the view and handle are this ring's own and are released once, here.
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.base.cast(),
            });
            CloseHandle(self.handle);
        }
    }
}
