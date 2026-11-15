use super::*;
use crate::audio::stream::bytes::RingWriter;
use crate::audio::stream::isolate::alloc::{new_record, watch_this_thread};
use crate::audio::stream::{ID3_SKIP_MAX, ID3_TAGS_MAX, OPEN_READ_MAX};
use std::sync::atomic::AtomicUsize;

/// The largest single allocation a hostile body may cause on the decode thread: the read-ahead
/// buffer and a few decoded packets fit well under it.
pub(super) const ALLOC_BOUND: usize = 1 << 20;

/// A byte source that, from its first read, records the largest allocation of the thread reading
/// it: the decode thread.
pub(super) struct Measured<S> {
    inner: S,
    record: &'static AtomicUsize,
    started: bool,
}

impl<S: Read> Read for Measured<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.started {
            self.started = true;
            watch_this_thread(self.record);
        }
        self.inner.read(buf)
    }
}

impl<S: Seek> Seek for Measured<S> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl<S: MediaSource> MediaSource for Measured<S> {
    fn is_seekable(&self) -> bool {
        self.inner.is_seekable()
    }

    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}

// Plays `bytes` from a ring whose writer stays open unless `finish`, and returns how the thread
// ended and the largest allocation it made.
fn play(bytes: &[u8], hint: Option<&'static str>, finish: bool) -> (DecodeEnd, usize) {
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(bytes.len() + 1, Arc::clone(&control));
    writer.try_write(bytes).unwrap();
    let held: Option<RingWriter> = if finish {
        writer.finish();
        None
    } else {
        Some(writer)
    };
    let measured = measure(ring, hint, &control);
    drop(held);
    measured
}

/// Plays `source` with the decode thread's allocations recorded; returns how it ended and the
/// largest allocation.
pub(super) fn measure(
    source: impl MediaSource + 'static,
    hint: Option<&'static str>,
    control: &Arc<StreamControl>,
) -> (DecodeEnd, usize) {
    // In a helper the decode thread is in another process, under its job's memory cap: only the
    // end is compared, and no allocation is recorded.
    if ISOLATED.get() {
        let (_, end) = start(media(source, hint), control).finish();
        return (end, 0);
    }
    let record = new_record();
    let source = Measured {
        inner: source,
        record,
        started: false,
    };
    let (_, end) = start(media(source, hint), control).finish();
    let largest = record.load(Ordering::Relaxed);
    // The decode thread always allocates something: proof the record works.
    assert!(largest > 0, "the allocation record saw nothing");
    (end, largest)
}

fn assert_refused(bytes: &[u8], hint: Option<&'static str>, finish: bool) {
    let (end, largest) = play(bytes, hint, finish);
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
    assert!(largest < ALLOC_BOUND, "allocated {largest} bytes");
}

fn syncsafe(n: u32) -> [u8; 4] {
    [
        ((n >> 21) & 0x7F) as u8,
        ((n >> 14) & 0x7F) as u8,
        ((n >> 7) & 0x7F) as u8,
        (n & 0x7F) as u8,
    ]
}

#[test]
fn an_id3_frame_claiming_a_gigabyte_is_never_read() {
    // A tag of 1,000 bytes whose TIT2 frame claims 1 GiB, cut short at 84 bytes.
    let mut body = b"ID3\x03\x00\x00".to_vec();
    body.extend_from_slice(&syncsafe(1_000));
    body.extend_from_slice(b"TIT2");
    body.extend_from_slice(&0x4000_0000u32.to_be_bytes());
    body.extend_from_slice(&[0, 0]);
    body.resize(84, 0);
    assert_refused(&body, Some("mp3"), true);

    // A tag claiming more than the skip cap is refused at its header, with the writer open.
    let mut huge = b"ID3\x03\x00\x00".to_vec();
    huge.extend_from_slice(&syncsafe(0x0FFF_FFFF));
    huge.extend_from_slice(&[0; 32]);
    assert_refused(&huge, Some("mp3"), false);
}

#[test]
fn back_to_back_empty_id3_tags_are_refused() {
    let mut body = Vec::new();
    for _ in 0..=ID3_TAGS_MAX {
        body.extend_from_slice(b"ID3\x03\x00\x00\x00\x00\x00\x00");
    }
    body.extend(mp3_silence(4));
    assert_refused(&body, Some("mp3"), false);

    // Up to the cap, the tags are skipped and the audio plays.
    let mut ok = Vec::new();
    for _ in 0..ID3_TAGS_MAX {
        ok.extend_from_slice(b"ID3\x03\x00\x00\x00\x00\x00\x05abcde");
    }
    ok.extend(mp3_silence(4));
    let (end, largest) = play(&ok, Some("mp3"), true);
    assert_eq!(end, DecodeEnd::Finished);
    assert!(largest < ALLOC_BOUND, "allocated {largest} bytes");
}

#[test]
fn an_mp3_behind_a_large_cover_tag_plays_and_a_tag_past_the_bound_is_refused() {
    // A 3 MiB tag, as an embedded cover makes, then audio: skipped unread on both sources.
    let mut body = b"ID3\x03\x00\x00".to_vec();
    body.extend_from_slice(&syncsafe(3 << 20));
    body.extend(std::iter::repeat_n(0xAB, 3 << 20));
    body.extend(mp3_silence(6));
    let (end, largest) = play(&body, Some("mp3"), true);
    assert_eq!(end, DecodeEnd::Finished);
    assert!(largest < ALLOC_BOUND, "allocated {largest} bytes");
    let control = Arc::new(StreamControl::new());
    let (writer, buffer) = growing_buffer(body.len() as u64, Arc::clone(&control));
    writer.write(&body).unwrap();
    writer.finish();
    let (segments, end) = start(media(buffer, Some("mp3")), &control).finish();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(frames_of(&segments), 6 * MP3_FRAME);

    // One byte past the bound is refused at the tag header, before a byte of it is read.
    let mut over = b"ID3\x03\x00\x00".to_vec();
    over.extend_from_slice(&syncsafe(ID3_SKIP_MAX as u32 - 9));
    over.extend_from_slice(&[0; 32]);
    assert_refused(&over, Some("mp3"), false);
}

// A 16-bit mono 44.1 kHz WAV header up to its `fmt ` chunk, with `block_align`.
fn wav_head(block_align: u16) -> Vec<u8> {
    let mut v = b"RIFF\xFF\xFF\xFF\xFFWAVEfmt ".to_vec();
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&44_100u32.to_le_bytes());
    v.extend_from_slice(&88_200u32.to_le_bytes());
    v.extend_from_slice(&block_align.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v
}

#[test]
fn a_wav_info_list_claiming_gigabytes_is_refused() {
    let mut body = wav_head(2);
    body.extend_from_slice(b"LIST");
    body.extend_from_slice(&0x7FFF_FFF0u32.to_le_bytes());
    body.extend_from_slice(b"INFOINAM");
    body.extend_from_slice(&0x7FFF_FFE0u32.to_le_bytes());
    body.extend_from_slice(b"title");
    assert_refused(&body, Some("wav"), false);
}

#[test]
fn a_wav_block_align_sizing_huge_packets_is_refused() {
    let mut body = wav_head(65_535);
    body.extend_from_slice(b"data");
    body.extend_from_slice(&0x7FFF_FFF0u32.to_le_bytes());
    body.extend_from_slice(&[0; 64]);
    assert_refused(&body, Some("wav"), false);
}

// A FLAC header with STREAMINFO not last, then one metadata block of `kind` holding `block`.
fn flac_with(kind: u8, block: &[u8]) -> Vec<u8> {
    let mut v = flac_bytes(1, FLAC_BLOCK)[..42].to_vec();
    v[4] = 0x00;
    v.push(0x80 | kind);
    v.extend_from_slice(&(block.len() as u32).to_be_bytes()[1..]);
    v.extend_from_slice(block);
    v
}

#[test]
fn a_flac_comment_claiming_gigabytes_is_refused() {
    let mut comment = 4u32.to_le_bytes().to_vec();
    comment.extend_from_slice(b"test");
    comment.extend_from_slice(&1u32.to_le_bytes());
    comment.extend_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    comment.extend_from_slice(b"TITLE=x");
    assert_refused(&flac_with(4, &comment), Some("flac"), false);
}

#[test]
fn a_flac_picture_claiming_gigabytes_is_refused() {
    let mut picture = 3u32.to_be_bytes().to_vec();
    picture.extend_from_slice(&0xFFFF_FFF0u32.to_be_bytes());
    picture.extend_from_slice(b"image/png");
    assert_refused(&flac_with(6, &picture), Some("flac"), false);
}

#[test]
fn adts_and_mp3_frames_allocate_only_what_their_headers_allow() {
    // The largest ADTS frame the 13-bit length allows, filled with junk, then a forbidden header.
    let mut adts = adts_silence(2);
    adts.extend_from_slice(&[0xFF, 0xF1, 0x50, 0x43, 0xFF, 0xFF, 0xFC]);
    adts.extend(std::iter::repeat_n(0x55, 8_191 - 7));
    adts.extend_from_slice(&ADTS_BAD_HEADER);
    let (end, largest) = play(&adts, Some("aac"), false);
    assert_eq!(end, DecodeEnd::Corrupt);
    assert!(largest < ALLOC_BOUND, "allocated {largest} bytes");

    // The largest MPEG-1 Layer III frame: 320 kbps at 32 kHz, padded.
    let mut mp3 = Vec::new();
    for _ in 0..8 {
        mp3.extend_from_slice(&[0xFF, 0xFB, 0xEA, 0xC0]);
        mp3.extend(std::iter::repeat_n(0u8, 1_441 - 4));
    }
    let (end, largest) = play(&mp3, Some("mp3"), true);
    assert_eq!(end, DecodeEnd::Finished);
    assert!(largest < ALLOC_BOUND, "allocated {largest} bytes");
}

#[test]
fn a_body_that_never_reaches_audio_stops_at_the_opening_bound() {
    // FLAC padding blocks without end: symphonia skips each one and reads on.
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(1 << 20, Arc::clone(&control));
    let feeder = thread::spawn(move || {
        let mut head = flac_bytes(1, FLAC_BLOCK)[..42].to_vec();
        head[4] = 0x00;
        let mut sent = 0u64;
        // Padding blocks of the largest length, one after another, in 64 KiB writes.
        let block = 4 + 0xFF_FFFF;
        let mut off = 0;
        let mut first = Some(head);
        loop {
            let piece = first.take().unwrap_or_else(|| {
                let mut piece = Vec::with_capacity(64 * 1_024 + 4);
                while piece.len() < 64 * 1_024 {
                    if off == 0 {
                        piece.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF]);
                        off = 4;
                    }
                    let n = (64 * 1_024 - piece.len()).min(block - off);
                    piece.extend(std::iter::repeat_n(0u8, n));
                    off = (off + n) % block;
                }
                piece
            });
            loop {
                match writer.try_write(&piece) {
                    Ok(_) => break,
                    Err(WriteError::Full { .. }) => thread::sleep(Duration::from_millis(1)),
                    Err(_) => return sent,
                }
            }
            sent += piece.len() as u64;
        }
    });
    let (_, end) = start(media(ring, Some("flac")), &control).finish();
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
    let sent = feeder.join().unwrap();
    assert!(sent >= OPEN_READ_MAX, "refused after {sent} bytes");
    assert!(
        sent < OPEN_READ_MAX + (4 << 20),
        "read {sent} bytes before refusing"
    );
}

#[test]
fn a_spec_change_on_every_packet_is_refused() {
    // One-packet chained Ogg Opus streams, alternating mono and stereo: 960 frames apiece.
    let mut bytes = Vec::new();
    for i in 0..40u32 {
        bytes.extend(ogg_opus_bytes(0x100 + i, 1 + (i % 2) as usize, 1, 0));
    }
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(bytes, 4_096, 64 * 1_024, &control);
    let (_, end) = start(media(feed.ring, Some("ogg")), &control).finish();
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
}

// The refusals above, with the decoding in a decode helper: the guards run there too.
mod isolated {
    use super::super::isolated;

    #[test]
    fn an_id3_frame_claiming_a_gigabyte_is_never_read() {
        isolated(super::an_id3_frame_claiming_a_gigabyte_is_never_read);
    }

    #[test]
    fn back_to_back_empty_id3_tags_are_refused() {
        isolated(super::back_to_back_empty_id3_tags_are_refused);
    }

    #[test]
    fn an_mp3_behind_a_large_cover_tag_plays_and_a_tag_past_the_bound_is_refused() {
        isolated(super::an_mp3_behind_a_large_cover_tag_plays_and_a_tag_past_the_bound_is_refused);
    }

    #[test]
    fn a_wav_info_list_claiming_gigabytes_is_refused() {
        isolated(super::a_wav_info_list_claiming_gigabytes_is_refused);
    }

    #[test]
    fn a_wav_block_align_sizing_huge_packets_is_refused() {
        isolated(super::a_wav_block_align_sizing_huge_packets_is_refused);
    }

    #[test]
    fn a_flac_comment_claiming_gigabytes_is_refused() {
        isolated(super::a_flac_comment_claiming_gigabytes_is_refused);
    }

    #[test]
    fn a_flac_picture_claiming_gigabytes_is_refused() {
        isolated(super::a_flac_picture_claiming_gigabytes_is_refused);
    }

    #[test]
    fn adts_and_mp3_frames_allocate_only_what_their_headers_allow() {
        isolated(super::adts_and_mp3_frames_allocate_only_what_their_headers_allow);
    }

    #[test]
    fn a_body_that_never_reaches_audio_stops_at_the_opening_bound() {
        isolated(super::a_body_that_never_reaches_audio_stops_at_the_opening_bound);
    }

    #[test]
    fn a_spec_change_on_every_packet_is_refused() {
        isolated(super::a_spec_change_on_every_packet_is_refused);
    }
}
