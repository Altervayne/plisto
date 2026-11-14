/*
 * The audio tap: a ring of the processed PCM a source yields, plus segment records that say where
 * each run of samples starts, its epoch, and its native rate and channel count. A source writes it on
 * the audio thread, after the DSP stage and before the output volume; readers poll it from elsewhere.
 *
 * The region is laid out so the same bytes can live in a file mapping shared with another process:
 * `#[repr(C)]`, fixed offsets, fixed-width little-endian fields, no pointers. Samples are f32 bits in
 * AtomicU32 slots, which have the layout of a u32 and compile to plain stores. The writer publishes a
 * monotonic cursor and never reads reader state, so a slow or dead reader can never stall playback; a
 * reader detects that it fell behind from the cursor gap.
 *
 * The engine's slot starts with no region and gains one once, the first time a reader asks for it, so
 * a session that never reads the tap holds no ring. The region is installed before `active` is set and
 * is never replaced or freed while the slot lives, so the audio thread reaches it through a lock-free
 * once-cell load and never holds a region that goes away under it.
 */

// -- Library Imports --
use std::mem::{offset_of, size_of};
use std::sync::atomic::{fence, AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

// -- Local Imports --
use super::AudioSpec;

/// "PTAP" read as a little-endian u32.
pub const TAP_MAGIC: u32 = u32::from_le_bytes(*b"PTAP");
pub const TAP_LAYOUT_VERSION: u32 = 1;
/// Samples in the ring. A power of two so a cursor masks to its slot.
pub const TAP_CAPACITY: usize = 1 << 20;
/// Segment records in the record ring.
pub const TAP_SEGMENTS: usize = 64;
/// Bytes from the start of the region to the first sample slot. The header is padded to a page so the
/// sample ring is page-aligned in a mapping.
pub const TAP_SAMPLES_OFFSET: usize = 4096;

// The writer publishes its cursor at least once per this many frames.
const PUBLISH_FRAMES: usize = 64;
// Samples the writer may have stored past the published cursor: 64 frames of 32 channels, and a wider
// layout publishes more often to stay inside it. A reader keeps this much clear of the cursor, so a
// slot it has just copied cannot be overwritten without the cursor showing it.
const TAP_GUARD: usize = PUBLISH_FRAMES * 32;
// The furthest a reader may trail the published cursor and still trust its oldest sample.
const READ_SPAN: u64 = (TAP_CAPACITY - TAP_GUARD) as u64;
// Padding that brings the header to TAP_SAMPLES_OFFSET: 32 bytes of fields, then the records.
const HEADER_RESERVED: usize = TAP_SAMPLES_OFFSET - 32 - TAP_SEGMENTS * size_of::<SegmentRecord>();

/// Where one run of samples starts. Every field is written by the audio thread before the segment
/// cursor that covers it is published.
#[repr(C)]
pub struct SegmentRecord {
    pub start_cursor: AtomicU64,
    // Within one epoch the samples are the continuous output of one unbroken chain of sources. A new
    // epoch opens on a cold start (play, seek, load), when a writer resumes after it stopped writing,
    // and when a gapless successor follows a source that was not writing; a reader flushes on it. A
    // gapless boundary or a format change inside the chain keeps the epoch.
    pub epoch: AtomicU32,
    pub rate: AtomicU32,
    pub channels: AtomicU32,
    reserved: u32,
}

/// The fixed header at offset 0 of the region, layout v1. The sample ring follows at
/// `TAP_SAMPLES_OFFSET`.
#[repr(C)]
pub struct TapHeader {
    pub magic: u32,
    pub layout_version: u32,
    pub capacity: u32,
    pub segment_count: u32,
    // Samples written since the region was created. Published with Release.
    pub write_cursor: AtomicU64,
    // Segment records written since the region was created. Published with Release.
    pub segment_cursor: AtomicU64,
    pub segments: [SegmentRecord; TAP_SEGMENTS],
    reserved: [u8; HEADER_RESERVED],
}

// The cross-process layout. A change here is a new layout version.
const _: () = {
    assert!(size_of::<SegmentRecord>() == 24);
    assert!(offset_of!(SegmentRecord, start_cursor) == 0);
    assert!(offset_of!(SegmentRecord, epoch) == 8);
    assert!(offset_of!(SegmentRecord, rate) == 12);
    assert!(offset_of!(SegmentRecord, channels) == 16);
    assert!(size_of::<TapHeader>() == TAP_SAMPLES_OFFSET);
    assert!(offset_of!(TapHeader, magic) == 0);
    assert!(offset_of!(TapHeader, layout_version) == 4);
    assert!(offset_of!(TapHeader, capacity) == 8);
    assert!(offset_of!(TapHeader, segment_count) == 12);
    assert!(offset_of!(TapHeader, write_cursor) == 16);
    assert!(offset_of!(TapHeader, segment_cursor) == 24);
    assert!(offset_of!(TapHeader, segments) == 32);
    assert!(size_of::<AtomicU32>() == 4);
    assert!(TAP_CAPACITY.is_power_of_two());
};

impl TapHeader {
    pub(super) fn new() -> Self {
        Self {
            magic: TAP_MAGIC,
            layout_version: TAP_LAYOUT_VERSION,
            capacity: TAP_CAPACITY as u32,
            segment_count: TAP_SEGMENTS as u32,
            write_cursor: AtomicU64::new(0),
            segment_cursor: AtomicU64::new(0),
            segments: std::array::from_fn(|_| SegmentRecord {
                start_cursor: AtomicU64::new(0),
                epoch: AtomicU32::new(0),
                rate: AtomicU32::new(0),
                channels: AtomicU32::new(0),
                reserved: 0,
            }),
            reserved: [0; HEADER_RESERVED],
        }
    }
}

/// The memory a tap lives in: a v1 header and `TAP_CAPACITY` sample slots.
pub trait TapRegion: Send + Sync {
    fn header(&self) -> &TapHeader;
    fn samples(&self) -> &[AtomicU32];
}

/// A tap region on the process heap, for in-process readers.
pub struct HeapRegion {
    header: Box<TapHeader>,
    samples: Box<[AtomicU32]>,
}

impl HeapRegion {
    pub fn new() -> Self {
        Self {
            header: Box::new(TapHeader::new()),
            samples: (0..TAP_CAPACITY).map(|_| AtomicU32::new(0)).collect(),
        }
    }
}

impl Default for HeapRegion {
    fn default() -> Self {
        Self::new()
    }
}

impl TapRegion for HeapRegion {
    #[inline]
    fn header(&self) -> &TapHeader {
        &self.header
    }

    #[inline]
    fn samples(&self) -> &[AtomicU32] {
        &self.samples
    }
}

/// The engine's one tap: the region, whether anything is reading it, and the current epoch. Inactive
/// by default, which leaves the region untouched.
pub struct TapSlot {
    active: AtomicBool,
    epoch: AtomicU32,
    // Whether the last refill of the last writer wrote, and the epoch it wrote in. A gapless
    // successor continues that epoch only when it did. Both are touched only by refills, which all
    // run on the audio thread in play order, so the last refill is the predecessor's.
    writing: AtomicBool,
    written: AtomicU32,
    region: OnceLock<Box<dyn TapRegion>>,
}

impl TapSlot {
    /// A slot over `region`, ready to write once active.
    pub fn new(region: impl TapRegion + 'static) -> Self {
        let slot = Self::empty();
        let _ = slot.install(Box::new(region));
        slot
    }

    /// A slot with no region yet. It writes nothing until one is installed and it is active.
    pub fn empty() -> Self {
        Self {
            active: AtomicBool::new(false),
            epoch: AtomicU32::new(0),
            writing: AtomicBool::new(false),
            written: AtomicU32::new(0),
            region: OnceLock::new(),
        }
    }

    /// Gives the slot its region. Only the first call takes; a later one gets its region back.
    pub fn install(&self, region: Box<dyn TapRegion>) -> Result<(), Box<dyn TapRegion>> {
        self.region.set(region)
    }

    pub fn region(&self) -> Option<&dyn TapRegion> {
        self.region.get().map(|r| r.as_ref())
    }

    /// Turns writing on or off. Sources pick the change up at their next packet. An empty slot
    /// stays silent whatever this says.
    pub fn set_active(&self, on: bool) {
        self.active.store(on, Ordering::Relaxed);
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// The latest epoch opened and not given back.
    pub fn epoch(&self) -> u32 {
        self.epoch.load(Ordering::Relaxed)
    }

    /// The published write cursor, 0 with no region.
    pub fn write_cursor(&self) -> u64 {
        self.region()
            .map_or(0, |r| r.header().write_cursor.load(Ordering::Acquire))
    }

    /// A writer for a source started cold, after a clear: it opens a new epoch. Engine thread only.
    pub fn cold(self: &Arc<Self>) -> TapWriter {
        TapWriter::new(Arc::clone(self), self.next_epoch(), true)
    }

    /// A writer for a source queued gapless behind the playing one: at its first sample it continues
    /// the epoch the source it follows last wrote in, when that one was writing. A cold start opened
    /// meanwhile does not move it: the successor still plays right after its predecessor.
    pub fn warm(self: &Arc<Self>) -> TapWriter {
        TapWriter::new(Arc::clone(self), 0, false)
    }

    fn next_epoch(&self) -> u32 {
        self.epoch.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
    }
}

/// One source's write side of the tap, owned by the source and run on the audio thread. The slot's
/// `active` flag and the region cursor are read only at a packet refill; between refills the cursor
/// lives here, and each sample is one store.
pub struct TapWriter {
    slot: Arc<TapSlot>,
    epoch: u32,
    // The epoch has no record yet. A writer that starts writing again after a gap opens a new epoch
    // rather than resume one a reader already saw.
    fresh: bool,
    started: bool,
    active: bool,
    cursor: u64,
    // The region's sample ring, taken at each refill that writes so a sample costs an index and a
    // store. Null until then. The slot never drops its region and this writer holds the slot.
    samples: *const AtomicU32,
    // Samples until the next publish, and the publish period for the current layout.
    publish_in: usize,
    publish_every: usize,
    // The layout last recorded, None until a record is written or after the slot went inactive.
    recorded: Option<AudioSpec>,
}

// SAFETY: `samples` points into the region the held slot keeps for its whole life, and the ring is
// only touched through atomics, so the writer may move to the audio thread.
unsafe impl Send for TapWriter {}

impl TapWriter {
    fn new(slot: Arc<TapSlot>, epoch: u32, fresh: bool) -> Self {
        Self {
            slot,
            epoch,
            fresh,
            started: false,
            active: false,
            cursor: 0,
            samples: std::ptr::null(),
            publish_in: 1,
            publish_every: 1,
            recorded: None,
        }
    }

    /// Whether the first refill has run. Before it, the source has not yielded a sample.
    #[inline]
    pub fn started(&self) -> bool {
        self.started
    }

    /// Runs at the source's first sample and at every packet refill. Publishes what was written,
    /// re-reads `active`, and records a segment when writing starts or the layout changed. Returns
    /// whether the coming samples are written.
    pub fn refill(&mut self, spec: AudioSpec) -> bool {
        let first = !self.started;
        self.started = true;
        if self.active {
            self.publish();
        }
        let was_active = self.active;
        let region = self.slot.region.get().filter(|r| {
            r.samples().len() >= TAP_CAPACITY && self.slot.active.load(Ordering::Relaxed)
        });
        let predecessor_wrote = self.slot.writing.load(Ordering::Relaxed);
        self.active = region.is_some();
        self.slot.writing.store(self.active, Ordering::Relaxed);
        let Some(region) = region else {
            self.recorded = None;
            return false;
        };
        if !was_active && !self.fresh {
            self.epoch = if first && predecessor_wrote {
                self.slot.written.load(Ordering::Relaxed)
            } else {
                self.slot.next_epoch()
            };
        }
        self.slot.written.store(self.epoch, Ordering::Relaxed);
        self.samples = region.samples().as_ptr();
        let header = region.header();
        // This writer is the only one, so the published cursor is where the last source stopped.
        self.cursor = header.write_cursor.load(Ordering::Relaxed);
        self.publish_every = (PUBLISH_FRAMES * spec.channels as usize).clamp(1, TAP_GUARD);
        self.publish_in = self.publish_every;
        if self.recorded != Some(spec) {
            self.record(spec);
        }
        true
    }

    /// Stores one sample. Only called while `refill` last returned true.
    #[inline]
    pub fn push(&mut self, s: f32) {
        if self.samples.is_null() {
            return;
        }
        let i = (self.cursor as usize) & (TAP_CAPACITY - 1);
        // SAFETY: `i` is below TAP_CAPACITY, which `refill` checked against the ring's length, and
        // the ring outlives this writer.
        unsafe { (*self.samples.add(i)).store(s.to_bits(), Ordering::Relaxed) };
        self.cursor = self.cursor.wrapping_add(1);
        self.publish_in -= 1;
        if self.publish_in == 0 {
            self.publish();
            self.publish_in = self.publish_every;
        }
    }

    /// Publishes the samples written so far. Run when the source drains, so the next source picks up
    /// at the exact boundary.
    pub fn publish(&self) {
        let Some(region) = self.slot.region.get().filter(|_| self.active) else {
            return;
        };
        region
            .header()
            .write_cursor
            .store(self.cursor, Ordering::Release);
        // Orders the publish before the next stores, so a reader that sees an overwritten slot also
        // sees a cursor that tells it so.
        fence(Ordering::Release);
    }

    fn record(&mut self, spec: AudioSpec) {
        let Some(region) = self.slot.region.get() else {
            return;
        };
        let header = region.header();
        let n = header.segment_cursor.load(Ordering::Relaxed);
        fence(Ordering::Release);
        let rec = &header.segments[(n as usize) & (TAP_SEGMENTS - 1)];
        rec.start_cursor.store(self.cursor, Ordering::Relaxed);
        rec.epoch.store(self.epoch, Ordering::Relaxed);
        rec.rate.store(spec.sample_rate, Ordering::Relaxed);
        rec.channels.store(spec.channels as u32, Ordering::Relaxed);
        header
            .segment_cursor
            .store(n.wrapping_add(1), Ordering::Release);
        self.recorded = Some(spec);
        self.fresh = false;
    }
}

impl Drop for TapWriter {
    /// A cold writer that never wrote gives its epoch back, so the slot's epoch stays the last one a
    /// reader can see. Only while it is still the latest: a later epoch already opened keeps its number.
    fn drop(&mut self) {
        if self.fresh {
            let _ = self.slot.epoch.compare_exchange(
                self.epoch,
                self.epoch.wrapping_sub(1),
                Ordering::Relaxed,
                Ordering::Relaxed,
            );
        }
    }
}

/// The reader fell too far behind the writer: the samples or records it wanted were overwritten.
#[derive(Debug, PartialEq, Eq)]
pub struct Overrun;

/// One segment record as a reader sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub start_cursor: u64,
    pub epoch: u32,
    pub rate: u32,
    pub channels: u16,
}

/// A reader's position in the sample and record rings. It never writes to the region. A read copies,
/// then re-checks the write cursor, so a copy the writer overtook is reported, never returned.
pub struct TapReader {
    cursor: u64,
    segment: u64,
}

impl TapReader {
    /// A reader at the region's live position, with the record governing it next in line.
    pub fn live(region: &(impl TapRegion + ?Sized)) -> Self {
        let mut r = Self {
            cursor: 0,
            segment: 0,
        };
        r.resync(region);
        r
    }

    /// A reader at the given sample and record cursors.
    pub fn at(cursor: u64, segment: u64) -> Self {
        Self { cursor, segment }
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    /// Jumps to the live position after an overrun.
    pub fn resync(&mut self, region: &(impl TapRegion + ?Sized)) {
        let header = region.header();
        self.cursor = header.write_cursor.load(Ordering::Acquire);
        self.segment = header
            .segment_cursor
            .load(Ordering::Acquire)
            .saturating_sub(1);
    }

    /// Copies up to `out.len()` published samples from the reader's cursor without moving it. The
    /// copy is only good once `commit` accepts it.
    pub fn copy(
        &self,
        region: &(impl TapRegion + ?Sized),
        out: &mut [f32],
    ) -> Result<usize, Overrun> {
        let written = region.header().write_cursor.load(Ordering::Acquire);
        let lag = written.saturating_sub(self.cursor);
        if lag > READ_SPAN {
            return Err(Overrun);
        }
        let n = out.len().min(lag as usize);
        let samples = region.samples();
        for (i, s) in out[..n].iter_mut().enumerate() {
            let slot = ((self.cursor + i as u64) as usize) & (TAP_CAPACITY - 1);
            *s = f32::from_bits(samples[slot].load(Ordering::Relaxed));
        }
        Ok(n)
    }

    /// Re-checks the write cursor after a `copy` of `n` samples and moves past them. Overrun means
    /// the writer overwrote part of the copy while it ran.
    pub fn commit(&mut self, region: &(impl TapRegion + ?Sized), n: usize) -> Result<(), Overrun> {
        fence(Ordering::Acquire);
        let written = region.header().write_cursor.load(Ordering::Relaxed);
        if written.saturating_sub(self.cursor) > READ_SPAN {
            return Err(Overrun);
        }
        self.cursor += n as u64;
        Ok(())
    }

    /// `copy` then `commit`.
    pub fn read(
        &mut self,
        region: &(impl TapRegion + ?Sized),
        out: &mut [f32],
    ) -> Result<usize, Overrun> {
        let n = self.copy(region, out)?;
        self.commit(region, n)?;
        Ok(n)
    }

    /// The next segment record, or None when the reader has seen them all.
    pub fn next_segment(
        &mut self,
        region: &(impl TapRegion + ?Sized),
    ) -> Result<Option<Segment>, Overrun> {
        let header = region.header();
        let written = header.segment_cursor.load(Ordering::Acquire);
        if self.segment >= written {
            return Ok(None);
        }
        // The record after the published ones may be mid-write over the oldest slot, hence `>=`.
        if written - self.segment >= TAP_SEGMENTS as u64 {
            return Err(Overrun);
        }
        let rec = &header.segments[(self.segment as usize) & (TAP_SEGMENTS - 1)];
        let seg = Segment {
            start_cursor: rec.start_cursor.load(Ordering::Relaxed),
            epoch: rec.epoch.load(Ordering::Relaxed),
            rate: rec.rate.load(Ordering::Relaxed),
            channels: rec.channels.load(Ordering::Relaxed) as u16,
        };
        fence(Ordering::Acquire);
        if header.segment_cursor.load(Ordering::Relaxed) - self.segment >= TAP_SEGMENTS as u64 {
            return Err(Overrun);
        }
        self.segment += 1;
        Ok(Some(seg))
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::audio::decode;
    use crate::audio::dsp::{DspShared, DspStage};
    use crate::audio::source::tests::{bits, raw_samples, write_wav, TempDir};
    use crate::audio::source::{open_source, DecoderSource};
    use std::path::Path;

    pub(in crate::audio) const STEREO: AudioSpec = AudioSpec {
        sample_rate: 44_100,
        channels: 2,
    };

    fn heap_slot() -> Arc<TapSlot> {
        Arc::new(TapSlot::new(HeapRegion::new()))
    }

    pub(in crate::audio) fn region(slot: &TapSlot) -> &dyn TapRegion {
        slot.region().expect("the slot has a region")
    }

    // A source over `path` with an identity stage, built the way the engine builds one.
    pub(in crate::audio) fn source(
        path: &Path,
        start_secs: Option<f64>,
        tap: Option<TapWriter>,
    ) -> DecoderSource {
        open_source(path, start_secs, 0.0, &Arc::new(DspShared::default()), tap)
            .expect("primes the first packet")
    }

    pub(in crate::audio) fn cursors(slot: &TapSlot) -> (u64, u64) {
        let header = region(slot).header();
        (
            header.write_cursor.load(Ordering::Relaxed),
            header.segment_cursor.load(Ordering::Relaxed),
        )
    }

    // Every published sample, read from the start of the ring.
    pub(in crate::audio) fn tapped(slot: &TapSlot) -> Vec<f32> {
        let mut out = vec![0.0; cursors(slot).0 as usize];
        let n = TapReader::at(0, 0)
            .read(region(slot), &mut out)
            .expect("the reader keeps up");
        assert_eq!(n, out.len());
        out
    }

    pub(in crate::audio) fn segments(slot: &TapSlot) -> Vec<Segment> {
        let mut reader = TapReader::at(0, 0);
        let mut out = Vec::new();
        while let Some(seg) = reader.next_segment(region(slot)).expect("no record lost") {
            out.push(seg);
        }
        out
    }

    pub(in crate::audio) fn segment(start_cursor: u64, epoch: u32, spec: AudioSpec) -> Segment {
        Segment {
            start_cursor,
            epoch,
            rate: spec.sample_rate,
            channels: spec.channels,
        }
    }

    // A writer on an active slot, already past its first refill on `spec`.
    fn writing(slot: &Arc<TapSlot>, spec: AudioSpec) -> TapWriter {
        let mut w = slot.cold();
        assert!(w.refill(spec));
        w
    }

    // -- Checks every region passes, each on a new inactive slot --

    pub(in crate::audio) fn check_output_bit_for_bit(slot: Arc<TapSlot>) {
        let dir = TempDir::new("tap_output");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 3_000);

        // A non-identity stage, so the tap is shown to sit after the DSP.
        slot.set_active(true);
        let dec = decode::Decoder::open(&path).expect("opens the WAV");
        let src = DecoderSource::new(dec, 0.0, DspStage::with_preamp(-6.0), Some(slot.cold()))
            .expect("primes");
        let out: Vec<f32> = src.collect();
        assert_ne!(bits(&out), bits(&raw_samples(&path)));
        assert_eq!(bits(&tapped(&slot)), bits(&out));
        assert_eq!(segments(&slot), vec![segment(0, 1, STEREO)]);
    }

    pub(in crate::audio) fn check_inactive_writes_nothing(slot: Arc<TapSlot>) {
        let dir = TempDir::new("tap_inactive");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 3_000);

        let out: Vec<f32> = source(&path, None, Some(slot.cold())).collect();
        assert_eq!(bits(&out), bits(&raw_samples(&path)));
        assert_eq!(cursors(&slot), (0, 0));
        assert!(region(&slot)
            .samples()
            .iter()
            .all(|s| s.load(Ordering::Relaxed) == 0));
    }

    pub(in crate::audio) fn check_gapless_boundary(slot: Arc<TapSlot>) {
        let dir = TempDir::new("tap_gapless");
        let (a, b) = (dir.path.join("a.wav"), dir.path.join("b.wav"));
        write_wav(&a, 44_100, 2, 5_123);
        write_wav(&b, 44_100, 2, 7_077);

        // Queued back to back, as the engine appends a preload behind the playing source.
        slot.set_active(true);
        let (input, output) = rodio::queue::queue::<f32>(false);
        input.append(source(&a, None, Some(slot.cold())));
        input.append(source(&b, None, Some(slot.warm())));
        let mut played = Vec::new();
        for s in output {
            played.push(s);
        }

        let mut expect = raw_samples(&a);
        let boundary = expect.len() as u64;
        expect.extend(raw_samples(&b));
        assert_eq!(bits(&played), bits(&expect));
        assert_eq!(bits(&tapped(&slot)), bits(&expect));
        assert_eq!(
            segments(&slot),
            vec![segment(0, 1, STEREO), segment(boundary, 1, STEREO)]
        );
    }

    pub(in crate::audio) fn check_seek_epoch(slot: Arc<TapSlot>) {
        let dir = TempDir::new("tap_seek");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 20_000);

        // The playing source is cut mid-stream, so only what it published counts.
        slot.set_active(true);
        let mut playing = source(&path, None, Some(slot.cold()));
        let heard: Vec<f32> = playing.by_ref().take(1_000).collect();
        drop(playing);
        let cut = cursors(&slot).0;
        assert!(cut > 0 && cut <= 1_000);

        let resumed: Vec<f32> = source(&path, Some(0.25), Some(slot.cold())).collect();
        let tap = tapped(&slot);
        assert_eq!(bits(&tap[..cut as usize]), bits(&heard[..cut as usize]));
        assert_eq!(bits(&tap[cut as usize..]), bits(&resumed));
        assert_eq!(
            segments(&slot),
            vec![segment(0, 1, STEREO), segment(cut, 2, STEREO)]
        );
    }

    pub(in crate::audio) fn check_overrun(slot: Arc<TapSlot>) {
        slot.set_active(true);
        let mut w = writing(&slot, STEREO);
        for i in 0..TAP_CAPACITY + 10 {
            w.push(i as f32);
        }
        w.publish();
        let region = region(&slot);
        let mut out = vec![0.0; 100];

        assert_eq!(TapReader::at(0, 0).read(region, &mut out), Err(Overrun));
        // Within the readable span, the samples are the ones written there.
        let end = cursors(&slot).0;
        let mut recent = TapReader::at(end - 100, 0);
        assert_eq!(recent.read(region, &mut out), Ok(100));
        assert_eq!(out[99], (TAP_CAPACITY + 9) as f32);
        // A resync lands on the live position.
        let mut reader = TapReader::at(0, 0);
        reader.resync(region);
        assert_eq!(reader.read(region, &mut out), Ok(0));

        // The record ring overruns the same way.
        for i in 0..TAP_SEGMENTS {
            let spec = AudioSpec {
                sample_rate: 44_100 + i as u32,
                channels: 2,
            };
            assert!(w.refill(spec));
        }
        assert_eq!(TapReader::at(0, 0).next_segment(region), Err(Overrun));
    }

    pub(in crate::audio) fn check_torn_read(slot: Arc<TapSlot>) {
        slot.set_active(true);
        let mut w = writing(&slot, STEREO);
        for _ in 0..1_000 {
            w.push(0.5);
        }
        w.publish();
        let region = region(&slot);
        let mut out = vec![0.0; 1_000];

        // The writer moves on a little between the copy and the re-check: the copy stands.
        let mut reader = TapReader::at(0, 0);
        assert_eq!(reader.copy(region, &mut out), Ok(1_000));
        for _ in 0..10 {
            w.push(0.25);
        }
        w.publish();
        assert_eq!(reader.commit(region, 1_000), Ok(()));
        assert_eq!(reader.cursor(), 1_000);

        // The writer laps the copied slots between the copy and the re-check: the copy is refused.
        let mut reader = TapReader::at(0, 0);
        assert_eq!(reader.copy(region, &mut out), Ok(1_000));
        for _ in 0..TAP_CAPACITY {
            w.push(0.75);
        }
        w.publish();
        assert_eq!(reader.commit(region, 1_000), Err(Overrun));
        assert_eq!(reader.cursor(), 0);
    }

    #[test]
    fn the_header_layout_is_fixed() {
        assert_eq!(size_of::<TapHeader>(), 4096);
        assert_eq!(offset_of!(TapHeader, write_cursor), 16);
        assert_eq!(offset_of!(TapHeader, segment_cursor), 24);
        assert_eq!(offset_of!(TapHeader, segments), 32);
        assert_eq!(size_of::<SegmentRecord>(), 24);
        assert_eq!(offset_of!(SegmentRecord, epoch), 8);
        assert_eq!(TAP_MAGIC.to_le_bytes(), *b"PTAP");

        let region = HeapRegion::new();
        let header = region.header();
        assert_eq!(header.magic, TAP_MAGIC);
        assert_eq!(header.layout_version, 1);
        assert_eq!(header.capacity, 1 << 20);
        assert_eq!(header.segment_count, 64);
        assert_eq!(region.samples().len(), 1 << 20);
    }

    #[test]
    fn the_tap_is_the_source_output_bit_for_bit() {
        check_output_bit_for_bit(heap_slot());
    }

    #[test]
    fn an_inactive_slot_writes_nothing() {
        check_inactive_writes_nothing(heap_slot());
    }

    #[test]
    fn an_empty_slot_writes_nothing_even_when_active() {
        let dir = TempDir::new("tap_empty");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 3_000);

        let slot = Arc::new(TapSlot::empty());
        slot.set_active(true);
        let out: Vec<f32> = source(&path, None, Some(slot.cold())).collect();
        assert_eq!(bits(&out), bits(&raw_samples(&path)));
        assert!(slot.region().is_none());
        assert_eq!(slot.write_cursor(), 0);
    }

    #[test]
    fn a_preview_writes_nothing() {
        let dir = TempDir::new("tap_preview");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 3_000);

        // A preview opens its source with no writer, so even an active slot stays empty.
        let slot = heap_slot();
        slot.set_active(true);
        let out: Vec<f32> = source(&path, Some(0.01), None).collect();
        assert!(!out.is_empty());
        assert_eq!(cursors(&slot), (0, 0));
    }

    #[test]
    fn a_gapless_pair_records_the_boundary_cursor() {
        check_gapless_boundary(heap_slot());
    }

    #[test]
    fn a_seek_starts_a_new_epoch() {
        check_seek_epoch(heap_slot());
    }

    #[test]
    fn a_spec_change_records_a_segment() {
        let mono = AudioSpec {
            sample_rate: 48_000,
            channels: 1,
        };
        let slot = heap_slot();
        slot.set_active(true);
        let mut w = writing(&slot, STEREO);
        for _ in 0..10 {
            w.push(0.5);
        }
        // Same layout: no record.
        assert!(w.refill(STEREO));
        for _ in 0..6 {
            w.push(0.5);
        }
        assert!(w.refill(mono));
        w.push(0.25);
        // Writing that stops and starts again records the layout anew, in a new epoch.
        slot.set_active(false);
        assert!(!w.refill(mono));
        slot.set_active(true);
        assert!(w.refill(mono));
        w.publish();

        assert_eq!(cursors(&slot).0, 17);
        assert_eq!(
            segments(&slot),
            vec![
                segment(0, 1, STEREO),
                segment(16, 1, mono),
                segment(17, 2, mono)
            ]
        );
    }

    #[test]
    fn a_gapless_successor_after_a_gap_opens_a_new_epoch() {
        let slot = heap_slot();
        let mut a = slot.cold();
        assert!(!a.refill(STEREO));
        let mut b = slot.warm();
        slot.set_active(true);
        assert!(b.refill(STEREO));
        b.push(0.5);
        b.publish();
        // The predecessor wrote nothing, so the successor does not continue its epoch.
        assert_eq!(segments(&slot), vec![segment(0, 2, STEREO)]);
    }

    // The (start cursor, epoch) of every record.
    fn records(slot: &TapSlot) -> Vec<(u64, u32)> {
        segments(slot)
            .iter()
            .map(|s| (s.start_cursor, s.epoch))
            .collect()
    }

    // Runs one packet of `n` samples through `w`, then publishes as a draining source does.
    fn play(w: &mut TapWriter, n: usize) {
        if w.refill(STEREO) {
            for _ in 0..n {
                w.push(0.5);
            }
        }
        w.publish();
    }

    #[test]
    fn a_cold_start_opened_during_a_gapless_handover_keeps_its_own_epoch() {
        let slot = heap_slot();
        slot.set_active(true);
        let mut a = slot.cold();
        play(&mut a, 128);
        let mut b = slot.warm();
        // A seek opens its writer before the sink is cleared, and the preload crosses over meanwhile.
        let mut c = slot.cold();
        play(&mut b, 128);
        play(&mut c, 128);
        assert_eq!(records(&slot), vec![(0, 1), (128, 1), (256, 2)]);
    }

    #[test]
    fn a_cold_start_that_never_plays_does_not_split_a_gapless_pair() {
        let slot = heap_slot();
        slot.set_active(true);
        let mut a = slot.cold();
        play(&mut a, 128);
        let b = slot.warm();
        // A seek whose file fails to open drops its writer unused.
        drop(slot.cold());
        let mut b = b;
        play(&mut b, 128);
        assert_eq!(records(&slot), vec![(0, 1), (128, 1)]);
    }

    #[test]
    fn a_successor_continues_the_epoch_its_predecessor_resumed_in() {
        let slot = heap_slot();
        slot.set_active(true);
        let mut a = slot.cold();
        play(&mut a, 128);
        slot.set_active(false);
        play(&mut a, 128);
        slot.set_active(true);
        play(&mut a, 128);
        let mut b = slot.warm();
        play(&mut b, 128);
        assert_eq!(records(&slot), vec![(0, 1), (128, 2), (256, 2)]);
    }

    #[test]
    fn a_successor_that_starts_writing_late_opens_a_new_epoch() {
        let slot = heap_slot();
        slot.set_active(true);
        let mut a = slot.cold();
        play(&mut a, 128);
        let mut b = slot.warm();
        slot.set_active(false);
        play(&mut b, 128);
        slot.set_active(true);
        play(&mut b, 128);
        assert_eq!(records(&slot), vec![(0, 1), (128, 2)]);
    }

    #[test]
    fn a_cold_writer_that_starts_late_writes_its_own_epoch() {
        let slot = heap_slot();
        let mut a = slot.cold();
        play(&mut a, 128);
        let mut c = slot.cold();
        slot.set_active(true);
        play(&mut a, 128);
        play(&mut c, 128);
        // Each cold writer keeps the epoch it opened, so the two runs never share one.
        assert_eq!(records(&slot), vec![(0, 1), (128, 2)]);
    }

    #[test]
    fn a_cold_writer_dropped_before_writing_gives_its_epoch_back() {
        let slot = heap_slot();
        slot.set_active(true);
        let mut a = slot.cold();
        play(&mut a, 128);
        // A seek whose file fails to open.
        drop(slot.cold());
        assert_eq!(slot.epoch(), 1);
        let mut c = slot.cold();
        play(&mut c, 128);
        assert_eq!(records(&slot), vec![(0, 1), (128, 2)]);
        assert_eq!(slot.epoch(), 2);
    }

    #[test]
    fn a_cold_writer_dropped_after_a_later_one_opened_keeps_the_epoch() {
        let slot = heap_slot();
        slot.set_active(true);
        let a = slot.cold();
        let mut b = slot.cold();
        drop(a);
        assert_eq!(slot.epoch(), 2);
        play(&mut b, 128);
        let c = slot.cold();
        drop(b);
        assert_eq!(slot.epoch(), 3);
        drop(c);
        assert_eq!(slot.epoch(), 2);
        assert_eq!(records(&slot), vec![(0, 2)]);
    }

    #[test]
    fn a_warm_writer_dropped_before_writing_gives_nothing_back() {
        let slot = heap_slot();
        slot.set_active(true);
        let mut a = slot.cold();
        play(&mut a, 128);
        drop(slot.warm());
        assert_eq!(slot.epoch(), 1);
        let mut c = slot.cold();
        play(&mut c, 128);
        assert_eq!(records(&slot), vec![(0, 1), (128, 2)]);
    }

    #[test]
    fn a_lagging_reader_detects_overrun() {
        check_overrun(heap_slot());
    }

    #[test]
    fn a_torn_read_is_detected() {
        check_torn_read(heap_slot());
    }
}
