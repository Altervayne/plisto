/*
 * A reader for Plisto's audio tap, layout v1. The tap is a ring of 2^20 f32 samples (interleaved, the
 * source's native rate and channel count) in a named file mapping, plus a ring of 64 segment records.
 * A record says where a run of samples starts (`start_cursor`), its epoch, rate and channel count. The
 * epoch changes on every cold start (play, seek, load): samples after a new epoch do not continue the
 * ones before, so a reader flushes what it was accumulating. A gapless track boundary or a format change
 * gets a new record with the same epoch.
 *
 * Header, all little-endian: magic "PTAP" at 0, layout version at 4, capacity at 8, segment count at 12,
 * published write cursor (u64, samples written since creation) at 16, published segment cursor (u64) at
 * 24, then 64 records of 24 bytes from 32 (start_cursor u64, epoch u32, rate u32, channels u32,
 * reserved). Samples start at byte 4096. The writer never waits for readers. A reader detects that it
 * fell behind from the cursor gap and must resync to the live position: that is an overrun.
 *
 * This module has no dependency on the rest of the program: copy it as is.
 */

// -- Library Imports --
use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{fence, AtomicU32, AtomicU64, Ordering};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS,
};

pub const LAYOUT_VERSION: u32 = 1;
/// Samples in the ring.
pub const CAPACITY: usize = 1 << 20;
pub const SEGMENTS: usize = 64;
/// Bytes from the start of the mapping to the first sample.
pub const SAMPLES_OFFSET: usize = 4096;
/// Bytes in a mapping: the header page, then the ring.
pub const MAP_BYTES: usize = SAMPLES_OFFSET + CAPACITY * 4;
/// The most samples one `Event::Samples` holds.
pub const CHUNK: usize = 4096;

const MAGIC: u32 = u32::from_le_bytes(*b"PTAP");
const OFF_WRITE_CURSOR: usize = 16;
const OFF_SEGMENT_CURSOR: usize = 24;
const OFF_SEGMENTS: usize = 32;
const SEGMENT_BYTES: usize = 24;
// The writer may have stored this many samples past the published cursor (64 frames of 32 channels).
// A reader stays this far clear of the cursor, so a slot it copies cannot have been rewritten unseen.
const GUARD: u64 = 64 * 32;
const READ_SPAN: u64 = CAPACITY as u64 - GUARD;

/// A tap mapping opened read-only. The mapping outlives the writer while any reader holds it.
pub struct Mapping {
    handle: HANDLE,
    base: *const u8,
}

// SAFETY: the view is shared memory read only through atomics, and the handle is a kernel object
// usable from any thread.
unsafe impl Send for Mapping {}
// SAFETY: as above; no method mutates the struct.
unsafe impl Sync for Mapping {}

impl Mapping {
    /// Opens the mapping `name` (`Local\plisto-tap-<pid>-<nonce>`, from `--plisto-tap`). Fails when the
    /// name is unknown or the header is not layout v1.
    pub fn open(name: &str) -> io::Result<Self> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated name and a plain access mask.
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a valid mapping handle; a mapping smaller than MAP_BYTES fails here.
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, MAP_BYTES) };
        if view.Value.is_null() {
            let err = io::Error::last_os_error();
            // SAFETY: the handle was opened above and is not used again.
            unsafe { CloseHandle(handle) };
            return Err(err);
        }
        let map = Self {
            handle,
            base: view.Value.cast(),
        };
        if map.u32_at(0) != MAGIC
            || map.u32_at(4) != LAYOUT_VERSION
            || map.u32_at(8) as usize != CAPACITY
            || map.u32_at(12) as usize != SEGMENTS
        {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        Ok(map)
    }

    fn u32_at(&self, offset: usize) -> u32 {
        // SAFETY: offset is inside the page-aligned view, 4-aligned, and the view lives as long as self.
        unsafe { &*self.base.add(offset).cast::<AtomicU32>() }.load(Ordering::Relaxed)
    }

    fn u64_at(&self, offset: usize, order: Ordering) -> u64 {
        // SAFETY: as `u32_at`, 8-aligned.
        unsafe { &*self.base.add(offset).cast::<AtomicU64>() }.load(order)
    }

    /// Samples written so far, as the writer last published them.
    fn write_cursor(&self, order: Ordering) -> u64 {
        self.u64_at(OFF_WRITE_CURSOR, order)
    }

    fn segment_cursor(&self, order: Ordering) -> u64 {
        self.u64_at(OFF_SEGMENT_CURSOR, order)
    }

    fn record(&self, index: u64) -> Segment {
        let at = OFF_SEGMENTS + (index as usize & (SEGMENTS - 1)) * SEGMENT_BYTES;
        Segment {
            start_cursor: self.u64_at(at, Ordering::Relaxed),
            epoch: self.u32_at(at + 8),
            rate: self.u32_at(at + 12),
            channels: self.u32_at(at + 16),
        }
    }

    fn sample(&self, cursor: u64) -> f32 {
        let at = SAMPLES_OFFSET + (cursor as usize & (CAPACITY - 1)) * 4;
        f32::from_bits(self.u32_at(at))
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: the view and handle are this mapping's own and are released once, here.
        unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.base.cast_mut().cast(),
            });
            CloseHandle(self.handle);
        }
    }
}

/// One segment record: where a run of samples starts and how to read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub start_cursor: u64,
    pub epoch: u32,
    pub rate: u32,
    pub channels: u32,
}

/// What `Follower::poll` reports, in stream order.
#[derive(Debug, PartialEq)]
pub enum Event<'a> {
    /// The samples that follow belong to this segment. Compare `epoch` with the last one seen: a new
    /// epoch is a discontinuity.
    Segment(Segment),
    /// Consecutive samples of `segment`. `first` is the absolute cursor of `data[0]`, so the channel of
    /// `data[i]` is `(first + i - segment.start_cursor) % segment.channels`.
    Samples {
        segment: Segment,
        first: u64,
        data: &'a [f32],
    },
    /// The reader fell behind and lost samples. It is already back at the live position.
    Overrun,
}

/// A reader's place in the ring. Call `poll` often: the ring holds a few seconds, and a reader that
/// stays away longer than that is resynced and told so with `Event::Overrun`.
pub struct Follower {
    cursor: u64,
    // Records read so far.
    segment: u64,
    current: Option<Segment>,
    // Records read but not yet reached by the cursor.
    upcoming: VecDeque<Segment>,
}

impl Follower {
    /// A follower at the live position: it reads what is published from now on.
    pub fn live(map: &Mapping) -> Self {
        let mut f = Self {
            cursor: 0,
            segment: 0,
            current: None,
            upcoming: VecDeque::new(),
        };
        f.resync(map);
        f
    }

    // Jumps to the live position. Starts two records back so the one governing the cursor is read.
    fn resync(&mut self, map: &Mapping) {
        self.cursor = map.write_cursor(Ordering::Acquire);
        self.segment = map.segment_cursor(Ordering::Acquire).saturating_sub(2);
        self.current = None;
        self.upcoming.clear();
    }

    // Reads the records published since the last call. False when the writer lapped the record ring.
    fn pull_segments(&mut self, map: &Mapping) -> bool {
        let written = map.segment_cursor(Ordering::Acquire);
        while self.segment < written {
            // The slot after the published ones may be mid-write, hence `>=`.
            if written - self.segment >= SEGMENTS as u64 {
                return false;
            }
            let record = map.record(self.segment);
            fence(Ordering::Acquire);
            if map.segment_cursor(Ordering::Relaxed) - self.segment >= SEGMENTS as u64 {
                return false;
            }
            self.upcoming.push_back(record);
            self.segment += 1;
        }
        true
    }

    /// Reads everything published since the last call and hands it to `sink` in order.
    pub fn poll(&mut self, map: &Mapping, sink: &mut dyn FnMut(Event<'_>)) {
        let mut buf = [0f32; CHUNK];
        loop {
            let written = map.write_cursor(Ordering::Acquire);
            if written.saturating_sub(self.cursor) > READ_SPAN || !self.pull_segments(map) {
                self.resync(map);
                sink(Event::Overrun);
                return;
            }
            while let Some(next) = self.upcoming.front().copied() {
                if next.start_cursor > self.cursor {
                    break;
                }
                self.upcoming.pop_front();
                self.current = Some(next);
                sink(Event::Segment(next));
            }
            let end = self
                .upcoming
                .front()
                .map_or(written, |s| s.start_cursor.min(written));
            if end <= self.cursor {
                return;
            }
            let Some(segment) = self.current else {
                // Samples before any record have no format; skip them.
                self.cursor = end;
                continue;
            };
            let n = ((end - self.cursor) as usize).min(CHUNK);
            for (i, slot) in buf[..n].iter_mut().enumerate() {
                *slot = map.sample(self.cursor + i as u64);
            }
            // The writer may have lapped the slots just copied; the copy is then discarded.
            fence(Ordering::Acquire);
            let after = map.write_cursor(Ordering::Relaxed);
            if after.saturating_sub(self.cursor) > READ_SPAN {
                self.resync(map);
                sink(Event::Overrun);
                return;
            }
            sink(Event::Samples {
                segment,
                first: self.cursor,
                data: &buf[..n],
            });
            self.cursor += n as u64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_ring::TestRing;

    #[derive(Debug, PartialEq)]
    enum Seen {
        Segment(u64, u32),
        Samples(u64, Vec<f32>),
        Overrun,
    }

    // Everything one poll reports, with consecutive sample chunks of a segment joined.
    fn poll(f: &mut Follower, map: &Mapping) -> Vec<Seen> {
        let mut seen: Vec<Seen> = Vec::new();
        f.poll(map, &mut |ev| match ev {
            Event::Segment(s) => seen.push(Seen::Segment(s.start_cursor, s.epoch)),
            Event::Overrun => seen.push(Seen::Overrun),
            Event::Samples { first, data, .. } => match seen.last_mut() {
                Some(Seen::Samples(at, v)) if *at + v.len() as u64 == first => {
                    v.extend_from_slice(data)
                }
                _ => seen.push(Seen::Samples(first, data.to_vec())),
            },
        });
        seen
    }

    fn ramp(from: u64, to: u64) -> Vec<f32> {
        (from..to).map(|i| i as f32).collect()
    }

    #[test]
    fn a_foreign_or_missing_name_does_not_open() {
        assert!(Mapping::open(r"Local\plisto-tap-0-none").is_err());
    }

    #[test]
    fn a_continuous_stream_reads_in_order() {
        let mut ring = TestRing::create();
        let map = Mapping::open(ring.name()).unwrap();
        let mut f = Follower::live(&map);
        assert!(poll(&mut f, &map).is_empty());

        ring.record(1, 44_100, 2);
        for i in 0..10_000 {
            ring.push(i as f32);
        }
        ring.publish();
        assert_eq!(
            poll(&mut f, &map),
            vec![Seen::Segment(0, 1), Seen::Samples(0, ramp(0, 10_000))]
        );
        // Nothing new: nothing reported.
        assert!(poll(&mut f, &map).is_empty());

        for i in 10_000..10_500 {
            ring.push(i as f32);
        }
        ring.publish();
        assert_eq!(
            poll(&mut f, &map),
            vec![Seen::Samples(10_000, ramp(10_000, 10_500))]
        );
    }

    #[test]
    fn the_ring_wraps_without_a_gap() {
        let mut ring = TestRing::create();
        let map = Mapping::open(ring.name()).unwrap();
        let mut f = Follower::live(&map);
        ring.record(1, 48_000, 2);

        let step = CAPACITY as u64 * 3 / 4;
        let mut at = 0u64;
        for _ in 0..3 {
            for i in at..at + step {
                ring.push(i as f32);
            }
            ring.publish();
            let seen = poll(&mut f, &map);
            let samples: Vec<&Seen> = seen
                .iter()
                .filter(|s| matches!(s, Seen::Samples(..)))
                .collect();
            assert_eq!(samples, vec![&Seen::Samples(at, ramp(at, at + step))]);
            at += step;
        }
        assert!(at > CAPACITY as u64 * 2);
    }

    #[test]
    fn a_new_epoch_follows_its_record() {
        let mut ring = TestRing::create();
        let map = Mapping::open(ring.name()).unwrap();
        let mut f = Follower::live(&map);

        ring.record(1, 44_100, 2);
        for i in 0..100 {
            ring.push(i as f32);
        }
        // A seek: new epoch from sample 100 on, and a gapless boundary: same epoch, new record.
        ring.record(2, 44_100, 2);
        for i in 100..150 {
            ring.push(i as f32);
        }
        ring.record(2, 48_000, 1);
        for i in 150..200 {
            ring.push(i as f32);
        }
        ring.publish();
        assert_eq!(
            poll(&mut f, &map),
            vec![
                Seen::Segment(0, 1),
                Seen::Samples(0, ramp(0, 100)),
                Seen::Segment(100, 2),
                Seen::Samples(100, ramp(100, 150)),
                Seen::Segment(150, 2),
                Seen::Samples(150, ramp(150, 200)),
            ]
        );
    }

    #[test]
    fn a_lagging_reader_is_counted_and_resynced() {
        let mut ring = TestRing::create();
        let map = Mapping::open(ring.name()).unwrap();
        let mut f = Follower::live(&map);
        ring.record(1, 44_100, 2);
        for i in 0..CAPACITY as u64 + 10 {
            ring.push(i as f32);
        }
        ring.publish();
        assert_eq!(poll(&mut f, &map), vec![Seen::Overrun]);

        // After the resync the reader follows the live position, in the segment that governs it.
        let live = CAPACITY as u64 + 10;
        for i in live..live + 100 {
            ring.push(i as f32);
        }
        ring.publish();
        assert_eq!(
            poll(&mut f, &map),
            vec![
                Seen::Segment(0, 1),
                Seen::Samples(live, ramp(live, live + 100))
            ]
        );
    }

    #[test]
    fn a_lapped_record_ring_is_an_overrun() {
        let mut ring = TestRing::create();
        let map = Mapping::open(ring.name()).unwrap();
        let mut f = Follower::live(&map);
        for i in 0..SEGMENTS as u32 + 3 {
            ring.record(i + 1, 44_100, 2);
        }
        ring.publish();
        assert_eq!(poll(&mut f, &map), vec![Seen::Overrun]);
    }
}
