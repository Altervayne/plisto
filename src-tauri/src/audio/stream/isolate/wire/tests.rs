use super::decode::{read_helper, read_main};
use super::encode::frame;
use super::*;
use crate::audio::stream::isolate::alloc::{new_record, watch_this_thread};
use crate::audio::AudioSpec;
use std::io::{self, Cursor, Read};
use std::sync::atomic::Ordering;

mod inspect;
mod reader;

/// A reader that counts the bytes it hands out.
struct Counted {
    inner: Cursor<Vec<u8>>,
    taken: usize,
}

impl Read for Counted {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.taken += n;
        Ok(n)
    }
}

fn counted(bytes: Vec<u8>) -> Counted {
    Counted {
        inner: Cursor::new(bytes),
        taken: 0,
    }
}

fn header(kind: u8, len: u32) -> Vec<u8> {
    let mut bytes = vec![kind];
    bytes.extend(len.to_le_bytes());
    bytes
}

fn raw(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = header(kind, payload.len() as u32);
    bytes.extend(payload);
    bytes
}

fn chunk(rate: u32, channels: u16, samples: Vec<f32>) -> HelperFrame {
    HelperFrame::Chunk(PcmChunk {
        samples,
        spec: AudioSpec {
            sample_rate: rate,
            channels,
        },
    })
}

// A chunk payload: its head, then `sample_bytes` of zeros.
fn chunk_payload(rate: u32, channels: u16, frames: u32, sample_bytes: usize) -> Vec<u8> {
    let mut payload = rate.to_le_bytes().to_vec();
    payload.extend(channels.to_le_bytes());
    payload.extend(frames.to_le_bytes());
    payload.extend(vec![0u8; sample_bytes]);
    payload
}

const MAIN_KINDS: [u8; 6] = [OPEN, DATA, EOF, BROKEN, SEEK, SEEKS_CLOSED];
const HELPER_KINDS: [u8; 8] = [
    READY,
    OPENED,
    READ,
    CHUNK,
    BREAK,
    SEEKS_OPEN,
    CLOSE_SEEKS,
    END,
];

fn main_frames() -> Vec<MainFrame> {
    vec![
        MainFrame::Open {
            hint: Some("m4a".into()),
            seekable: true,
            guarded: true,
            len: Some(123_456_789),
        },
        MainFrame::Open {
            hint: Some("x".repeat(HINT_MAX)),
            seekable: false,
            guarded: false,
            len: None,
        },
        MainFrame::Open {
            hint: Some(String::new()),
            seekable: false,
            guarded: true,
            len: Some(0),
        },
        MainFrame::Open {
            hint: None,
            seekable: true,
            guarded: false,
            len: None,
        },
        MainFrame::Data(vec![7]),
        MainFrame::Data((0..READ_MAX).map(|i| i as u8).collect()),
        MainFrame::Eof,
        MainFrame::Broken,
        MainFrame::Seek {
            secs: 12.5,
            generation: 3,
        },
        MainFrame::Seek {
            secs: 0.0,
            generation: u64::MAX,
        },
        MainFrame::SeeksClosed { pending: None },
        MainFrame::SeeksClosed {
            pending: Some((61.25, 9)),
        },
    ]
}

fn helper_frames() -> Vec<HelperFrame> {
    let mut frames = vec![
        HelperFrame::Ready,
        HelperFrame::Opened {
            rate: 8_000,
            channels: 1,
            duration_secs: None,
        },
        HelperFrame::Opened {
            rate: 384_000,
            channels: MAX_CHANNELS,
            duration_secs: Some(0.0),
        },
        HelperFrame::Opened {
            rate: 44_100,
            channels: 2,
            duration_secs: Some(3_600.5),
        },
        HelperFrame::Read {
            source: ReadSource::Audio,
            pos: u64::MAX,
            max: READ_MAX,
        },
        HelperFrame::Read {
            source: ReadSource::Image,
            pos: 0,
            max: 1,
        },
        chunk(8_000, 1, vec![0.25]),
        chunk(384_000, 2, vec![0.5, -0.5, 1.0, -1.0, 1.5, -0.0]),
        HelperFrame::Break(UncheckedSeam::new(Seam::Seek(42))),
        HelperFrame::Break(UncheckedSeam::new(Seam::Chain)),
        HelperFrame::SeeksOpen,
        HelperFrame::CloseSeeks,
        HelperFrame::End(DecodeEnd::Finished),
        HelperFrame::End(DecodeEnd::SourceBroken),
        HelperFrame::End(DecodeEnd::Corrupt),
        HelperFrame::End(DecodeEnd::Panicked),
    ];
    for reason in [
        Unsupported::ContentType,
        Unsupported::Playlist,
        Unsupported::Format,
        Unsupported::Codec,
        Unsupported::Seek,
    ] {
        frames.push(HelperFrame::End(DecodeEnd::Failed(reason)));
    }
    frames
}

fn largest_chunk() -> HelperFrame {
    let count = CHUNK_FRAMES_MAX as usize * MAX_CHANNELS as usize;
    chunk(
        192_000,
        MAX_CHANNELS,
        (0..count).map(|i| i as f32 / count as f32).collect(),
    )
}

// Chunks compare by sample bits, so a round trip has to be exact.
fn same(a: &HelperFrame, b: &HelperFrame) -> bool {
    match (a, b) {
        (HelperFrame::Chunk(a), HelperFrame::Chunk(b)) => {
            a.spec == b.spec
                && a.samples.len() == b.samples.len()
                && a.samples
                    .iter()
                    .zip(&b.samples)
                    .all(|(x, y)| x.to_bits() == y.to_bits())
        }
        _ => format!("{a:?}") == format!("{b:?}"),
    }
}

fn helper_err(bytes: Vec<u8>) -> (WireError, usize) {
    let mut r = counted(bytes);
    match read_helper(&mut r) {
        Err(e) => (e, r.taken),
        Ok(frame) => panic!("decoded {frame:?}"),
    }
}

fn main_err(bytes: Vec<u8>) -> (WireError, usize) {
    let mut r = counted(bytes);
    match read_main(&mut r) {
        Err(e) => (e, r.taken),
        Ok(frame) => panic!("decoded {frame:?}"),
    }
}

#[test]
fn every_main_frame_round_trips() {
    let mut stream = Vec::new();
    for frame in main_frames() {
        frame.write(&mut stream).unwrap();
    }
    let mut r = MainReader::new(Cursor::new(stream));
    for frame in main_frames() {
        assert_eq!(r.read_frame(), Ok(Some(frame)));
    }
    assert_eq!(r.read_frame(), Ok(None));
}

#[test]
fn every_helper_frame_round_trips() {
    let mut stream = Vec::new();
    for frame in helper_frames() {
        frame.write(&mut stream).unwrap();
    }
    let mut r = HelperReader::new(Cursor::new(stream));
    for frame in helper_frames() {
        let read = r.read_frame().unwrap().unwrap();
        assert!(same(&read, &frame), "{read:?} != {frame:?}");
    }
    assert!(matches!(r.read_frame(), Ok(None)));
}

#[test]
fn the_largest_frames_fit_their_bounds_exactly() {
    let frame = largest_chunk();
    let bytes = frame.encode().unwrap();
    assert_eq!(bytes.len(), HEADER + CHUNK_MAX as usize);
    assert!(bytes.len() - HEADER <= WIRE_FRAME_MAX as usize);
    let read = read_helper(&mut Cursor::new(bytes)).unwrap().unwrap();
    assert!(same(&read, &frame));

    let open = main_frames()[1].encode().unwrap();
    assert_eq!(open.len(), HEADER + OPEN_MAX as usize - 8);
    let full = MainFrame::Open {
        hint: Some("y".repeat(HINT_MAX)),
        seekable: true,
        guarded: true,
        len: Some(u64::MAX),
    };
    let bytes = full.encode().unwrap();
    assert_eq!(bytes.len(), HEADER + OPEN_MAX as usize);
    assert_eq!(read_main(&mut Cursor::new(bytes)), Ok(Some(full)));
}

#[test]
fn a_frame_sent_the_wrong_way_is_an_unknown_kind() {
    for frame in main_frames() {
        let bytes = frame.encode().unwrap();
        let kind = bytes[0];
        assert_eq!(helper_err(bytes), (WireError::UnknownKind(kind), HEADER));
    }
    for frame in helper_frames() {
        let bytes = frame.encode().unwrap();
        let kind = bytes[0];
        assert_eq!(main_err(bytes), (WireError::UnknownKind(kind), HEADER));
    }
    assert_eq!(
        helper_err(raw(0x00, &[])),
        (WireError::UnknownKind(0), HEADER)
    );
    assert_eq!(
        main_err(raw(0xFF, &[])),
        (WireError::UnknownKind(0xFF), HEADER)
    );
}

#[test]
fn a_length_over_the_cap_is_refused_from_the_header() {
    for kind in HELPER_KINDS {
        assert_eq!(
            helper_err(header(kind, WIRE_FRAME_MAX + 1)),
            (WireError::TooLarge(WIRE_FRAME_MAX + 1), HEADER)
        );
    }
    for kind in MAIN_KINDS {
        assert_eq!(
            main_err(header(kind, WIRE_FRAME_MAX + 1)),
            (WireError::TooLarge(WIRE_FRAME_MAX + 1), HEADER)
        );
    }
}

#[test]
fn a_length_its_kind_never_has_is_refused_from_the_header() {
    let helper = [
        (READY, 1),
        (OPENED, 6),
        (OPENED, 16),
        (READ, 12),
        (READ, 14),
        (CHUNK, CHUNK_HEAD + 3),
        (CHUNK, CHUNK_MAX + 1),
        (BREAK, 0),
        (BREAK, 10),
        (SEEKS_OPEN, 1),
        (CLOSE_SEEKS, 1),
        (END, 0),
        (END, 3),
    ];
    for (kind, len) in helper {
        // A full payload follows, so the count proves none of it was read.
        let mut bytes = header(kind, len);
        bytes.extend(vec![0u8; len as usize]);
        assert_eq!(
            helper_err(bytes),
            (WireError::BadLength { kind, len }, HEADER)
        );
    }
    let main = [
        (OPEN, 3),
        (OPEN, OPEN_MAX + 1),
        (DATA, 0),
        (DATA, READ_MAX + 1),
        (EOF, 1),
        (BROKEN, 1),
        (SEEK, 15),
        (SEEK, 17),
        (SEEKS_CLOSED, 0),
        (SEEKS_CLOSED, 18),
    ];
    for (kind, len) in main {
        let mut bytes = header(kind, len);
        bytes.extend(vec![0u8; len as usize]);
        assert_eq!(
            main_err(bytes),
            (WireError::BadLength { kind, len }, HEADER)
        );
    }
}

#[test]
fn a_forged_maximum_length_allocates_nothing() {
    let mut kinds = HELPER_KINDS.to_vec();
    kinds.extend(MAIN_KINDS);
    kinds.push(0x42);
    let mut readers: Vec<Counted> = kinds
        .iter()
        .map(|&kind| {
            let mut bytes = header(kind, u32::MAX);
            bytes.extend([0u8; 64]);
            counted(bytes)
        })
        .collect();
    let mut errors = Vec::with_capacity(readers.len() * 2);
    let record = new_record();
    watch_this_thread(record);
    for r in &mut readers {
        errors.push(read_helper(r).err());
        r.inner.set_position(0);
        errors.push(read_main(r).err());
    }
    let largest = record.load(Ordering::Relaxed);
    assert_eq!(largest, 0, "allocated {largest} bytes");
    // A legal frame of the same reader does allocate: proof the record is live.
    let data = MainFrame::Data(vec![1; 64]).encode().unwrap();
    read_main(&mut Cursor::new(data)).unwrap();
    assert!(record.load(Ordering::Relaxed) >= 64);
    for e in errors {
        assert!(
            matches!(
                e,
                Some(WireError::TooLarge(u32::MAX) | WireError::UnknownKind(_))
            ),
            "{e:?}"
        );
    }
    for r in &readers {
        assert_eq!(r.taken, 2 * HEADER);
    }
}

#[test]
fn a_short_payload_is_refused_at_the_missing_field() {
    assert_eq!(helper_err(raw(BREAK, &[0])), (WireError::Short, 6));
    assert_eq!(helper_err(raw(END, &[4])), (WireError::Short, 6));
    let mut opened = 48_000u32.to_le_bytes().to_vec();
    opened.extend(2u16.to_le_bytes());
    opened.push(1);
    assert_eq!(helper_err(raw(OPENED, &opened)), (WireError::Short, 12));
    // The hint claims 5 bytes; 2 are left.
    assert_eq!(main_err(raw(OPEN, &[1, 5, b'm', 0])), (WireError::Short, 7));
    assert_eq!(main_err(raw(OPEN, &[0, 1, 1, 1])), (WireError::Short, 9));
    assert_eq!(main_err(raw(SEEKS_CLOSED, &[1])), (WireError::Short, 6));
}

#[test]
fn trailing_bytes_are_refused_unread() {
    assert_eq!(helper_err(raw(BREAK, &[1, 0])), (WireError::Trailing(1), 6));
    assert_eq!(
        helper_err(raw(BREAK, &[1, 0, 0, 0, 0, 0, 0, 0, 0])),
        (WireError::Trailing(8), 6)
    );
    assert_eq!(helper_err(raw(END, &[0, 0])), (WireError::Trailing(1), 6));
    let mut opened = 48_000u32.to_le_bytes().to_vec();
    opened.extend(2u16.to_le_bytes());
    opened.extend([0; 9]);
    assert_eq!(
        helper_err(raw(OPENED, &opened)),
        (WireError::Trailing(8), 12)
    );
    assert_eq!(
        main_err(raw(OPEN, &[0, 0, 0, 0, 9])),
        (WireError::Trailing(1), 9)
    );
    assert_eq!(
        main_err(raw(SEEKS_CLOSED, &[0, 0])),
        (WireError::Trailing(1), 6)
    );
}

#[test]
fn an_unknown_tag_is_refused() {
    let bad = |field, tag| WireError::BadTag { field, tag };
    assert_eq!(helper_err(raw(BREAK, &[2])), (bad("seam", 2), 6));
    assert_eq!(helper_err(raw(END, &[5])), (bad("decode_end", 5), 6));
    assert_eq!(helper_err(raw(END, &[4, 5])), (bad("unsupported", 5), 7));
    let mut read = vec![2];
    read.extend([0; 12]);
    assert_eq!(helper_err(raw(READ, &read)), (bad("source", 2), 6));
    let mut opened = 48_000u32.to_le_bytes().to_vec();
    opened.extend(2u16.to_le_bytes());
    opened.push(2);
    assert_eq!(helper_err(raw(OPENED, &opened)), (bad("duration", 2), 12));
    assert_eq!(main_err(raw(OPEN, &[2, 0, 0, 0])), (bad("hint", 2), 6));
    assert_eq!(main_err(raw(OPEN, &[0, 2, 0, 0])), (bad("seekable", 2), 7));
    assert_eq!(main_err(raw(OPEN, &[0, 0, 2, 0])), (bad("guarded", 2), 8));
    assert_eq!(main_err(raw(OPEN, &[0, 0, 0, 2])), (bad("len", 2), 9));
    assert_eq!(main_err(raw(SEEKS_CLOSED, &[2])), (bad("pending", 2), 6));
}

#[test]
fn an_oversized_or_non_utf8_hint_is_refused() {
    let mut long = vec![1, HINT_MAX as u8 + 1];
    long.extend(vec![b'a'; HINT_MAX + 1]);
    long.extend([0, 0, 0]);
    // The length byte alone refuses it; the hint bytes stay unread.
    assert_eq!(
        main_err(raw(OPEN, &long)),
        (WireError::HintTooLong(HINT_MAX + 1), 7)
    );
    assert_eq!(
        main_err(raw(OPEN, &[1, 2, 0xFF, 0xFE, 0, 0, 0])),
        (WireError::HintNotUtf8, 9)
    );
}

#[test]
fn an_opened_spec_or_duration_out_of_bounds_is_refused() {
    let opened = |rate: u32, channels: u16, duration: Option<f64>| {
        let mut payload = rate.to_le_bytes().to_vec();
        payload.extend(channels.to_le_bytes());
        match duration {
            Some(secs) => {
                payload.push(1);
                payload.extend(secs.to_le_bytes());
            }
            None => payload.push(0),
        }
        raw(OPENED, &payload)
    };
    let cases = [
        (opened(7_999, 2, None), WireError::BadRate(7_999), 9),
        (opened(384_001, 2, None), WireError::BadRate(384_001), 9),
        (opened(48_000, 0, None), WireError::BadChannels(0), 11),
        (opened(48_000, 9, None), WireError::BadChannels(9), 11),
        (
            opened(48_000, 2, Some(f64::NAN)),
            WireError::BadDuration,
            20,
        ),
        (
            opened(48_000, 2, Some(f64::INFINITY)),
            WireError::BadDuration,
            20,
        ),
        (opened(48_000, 2, Some(-0.5)), WireError::BadDuration, 20),
    ];
    for (bytes, want, taken) in cases {
        assert_eq!(helper_err(bytes), (want, taken));
    }
}

#[test]
fn a_chunk_spec_out_of_bounds_is_refused_before_its_samples() {
    let cases = [
        (48_000, 0, 1, WireError::BadChannels(0)),
        (48_000, MAX_CHANNELS + 1, 1, WireError::BadChannels(9)),
        (7_999, 2, 1, WireError::BadRate(7_999)),
        (384_001, 2, 1, WireError::BadRate(384_001)),
        (0, 2, 1, WireError::BadRate(0)),
        (48_000, 2, 0, WireError::BadFrames(0)),
        (
            48_000,
            2,
            CHUNK_FRAMES_MAX + 1,
            WireError::BadFrames(CHUNK_FRAMES_MAX + 1),
        ),
        // A product that would overflow if it were multiplied before the checks.
        (
            48_000,
            MAX_CHANNELS,
            u32::MAX,
            WireError::BadFrames(u32::MAX),
        ),
    ];
    for (rate, channels, frames, want) in cases {
        let payload = chunk_payload(rate, channels, frames, 64);
        assert_eq!(
            helper_err(raw(CHUNK, &payload)),
            (want, HEADER + CHUNK_HEAD as usize)
        );
    }
}

#[test]
fn a_chunk_whose_length_disagrees_with_its_spec_is_refused() {
    for sample_bytes in [4, 12, 20, 15] {
        let payload = chunk_payload(48_000, 2, 2, sample_bytes);
        assert_eq!(
            helper_err(raw(CHUNK, &payload)),
            (
                WireError::ChunkSize {
                    expected: 16,
                    got: sample_bytes
                },
                HEADER + CHUNK_HEAD as usize
            )
        );
    }
}

#[test]
fn a_read_max_out_of_bounds_is_refused() {
    for max in [0, READ_MAX + 1, u32::MAX] {
        let mut payload = vec![0];
        payload.extend(0u64.to_le_bytes());
        payload.extend(max.to_le_bytes());
        assert_eq!(
            helper_err(raw(READ, &payload)),
            (WireError::BadReadMax(max), HEADER + 13)
        );
    }
}

#[test]
fn a_seek_target_that_is_not_a_time_is_refused() {
    for secs in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, -1e-300] {
        let mut payload = secs.to_le_bytes().to_vec();
        payload.extend(1u64.to_le_bytes());
        assert_eq!(
            main_err(raw(SEEK, &payload)),
            (WireError::BadSeekTarget, HEADER + 8)
        );
        let mut pending = vec![1];
        pending.extend(&payload);
        assert_eq!(
            main_err(raw(SEEKS_CLOSED, &pending)),
            (WireError::BadSeekTarget, HEADER + 9)
        );
    }
}

#[test]
fn every_prefix_of_a_frame_is_torn_never_a_hang() {
    // The full-size `Data` frame is cut at its edges below; every byte of it would be slow.
    let mut frames: Vec<(Vec<u8>, bool)> = main_frames()
        .iter()
        .filter(|f| !matches!(f, MainFrame::Data(d) if d.len() > 1))
        .map(|f| (f.encode().unwrap(), true))
        .collect();
    frames.extend(helper_frames().iter().map(|f| (f.encode().unwrap(), false)));
    for (bytes, main) in &frames {
        for cut in 0..bytes.len() {
            let mut r = Cursor::new(bytes[..cut].to_vec());
            let torn = if *main {
                read_main(&mut r).map(|f| f.is_some())
            } else {
                read_helper(&mut r).map(|f| f.is_some())
            };
            let want = if cut == 0 {
                Ok(false)
            } else {
                Err(WireError::Torn)
            };
            assert_eq!(torn, want, "kind {:#x} cut at {cut}", bytes[0]);
        }
    }
    // The largest frames, cut at their edges.
    let data = MainFrame::Data(vec![1; READ_MAX as usize])
        .encode()
        .unwrap();
    let big = largest_chunk().encode().unwrap();
    for cut in [1, HEADER, HEADER + 1, data.len() - 1] {
        let mut r = Cursor::new(data[..cut].to_vec());
        assert_eq!(read_main(&mut r), Err(WireError::Torn));
    }
    for cut in [HEADER + 9, HEADER + 10, HEADER + 4097, big.len() - 1] {
        let mut r = Cursor::new(big[..cut].to_vec());
        assert!(matches!(read_helper(&mut r), Err(WireError::Torn)));
    }
}

#[test]
fn non_finite_samples_never_leave_the_codec() {
    let samples = vec![
        f32::NAN,
        f32::from_bits(0x7F80_0001),
        -f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        0.5,
        -0.0,
        1.5,
        3e38,
    ];
    let bytes = chunk(44_100, 1, samples).encode().unwrap();
    let read = read_helper(&mut Cursor::new(bytes)).unwrap().unwrap();
    let want = chunk(
        44_100,
        1,
        vec![0.0, 0.0, 0.0, 1.0, -1.0, 0.5, -0.0, 1.5, 3e38],
    );
    assert!(same(&read, &want), "{read:?}");
}

#[test]
fn encoding_refuses_what_decoding_would_and_writes_nothing() {
    let helper = [
        (chunk(48_000, 0, vec![0.0]), WireError::BadChannels(0)),
        (chunk(48_000, 9, vec![0.0; 9]), WireError::BadChannels(9)),
        (chunk(1, 1, vec![0.0]), WireError::BadRate(1)),
        (chunk(48_000, 1, vec![]), WireError::BadFrames(0)),
        (
            chunk(48_000, 1, vec![0.0; CHUNK_FRAMES_MAX as usize + 1]),
            WireError::BadFrames(CHUNK_FRAMES_MAX + 1),
        ),
        (
            chunk(48_000, 2, vec![0.0; 3]),
            WireError::ChunkSize {
                expected: 8,
                got: 12,
            },
        ),
        (
            HelperFrame::Read {
                source: ReadSource::Audio,
                pos: 0,
                max: 0,
            },
            WireError::BadReadMax(0),
        ),
        (
            HelperFrame::Read {
                source: ReadSource::Image,
                pos: 0,
                max: READ_MAX + 1,
            },
            WireError::BadReadMax(READ_MAX + 1),
        ),
        (
            HelperFrame::Opened {
                rate: 1,
                channels: 2,
                duration_secs: None,
            },
            WireError::BadRate(1),
        ),
        (
            HelperFrame::Opened {
                rate: 48_000,
                channels: 0,
                duration_secs: None,
            },
            WireError::BadChannels(0),
        ),
        (
            HelperFrame::Opened {
                rate: 48_000,
                channels: 2,
                duration_secs: Some(-1.0),
            },
            WireError::BadDuration,
        ),
        (
            HelperFrame::End(DecodeEnd::Cancelled),
            WireError::NotOnWire(DecodeEnd::Cancelled),
        ),
        (
            HelperFrame::End(DecodeEnd::ReaderGone),
            WireError::NotOnWire(DecodeEnd::ReaderGone),
        ),
    ];
    for (frame, want) in helper {
        let mut out = Vec::new();
        assert_eq!(frame.write(&mut out), Err(want));
        assert!(out.is_empty());
    }
    let main = [
        (
            MainFrame::Open {
                hint: Some("x".repeat(HINT_MAX + 1)),
                seekable: true,
                guarded: true,
                len: None,
            },
            WireError::HintTooLong(HINT_MAX + 1),
        ),
        (
            MainFrame::Data(vec![]),
            WireError::BadLength { kind: DATA, len: 0 },
        ),
        (
            MainFrame::Data(vec![0; READ_MAX as usize + 1]),
            WireError::BadLength {
                kind: DATA,
                len: READ_MAX + 1,
            },
        ),
        (
            MainFrame::Seek {
                secs: f64::NAN,
                generation: 1,
            },
            WireError::BadSeekTarget,
        ),
        (
            MainFrame::Seek {
                secs: -2.0,
                generation: 1,
            },
            WireError::BadSeekTarget,
        ),
        (
            MainFrame::SeeksClosed {
                pending: Some((f64::INFINITY, 1)),
            },
            WireError::BadSeekTarget,
        ),
    ];
    for (frame, want) in main {
        let mut out = Vec::new();
        assert_eq!(frame.write(&mut out), Err(want));
        assert!(out.is_empty());
    }
}

#[test]
fn the_encoder_checks_every_length_against_its_kind() {
    let fill = |n: usize| {
        move |out: &mut Vec<u8>| -> Result<(), WireError> {
            out.extend(vec![0u8; n]);
            Ok(())
        }
    };
    assert_eq!(
        frame(EOF, main_bounds, fill(1)),
        Err(WireError::BadLength { kind: EOF, len: 1 })
    );
    assert_eq!(
        frame(READ, helper_bounds, fill(12)),
        Err(WireError::BadLength {
            kind: READ,
            len: 12
        })
    );
    // A kind of the other direction has no legal length here.
    assert_eq!(
        frame(READY, main_bounds, fill(0)),
        Err(WireError::BadLength {
            kind: READY,
            len: 0
        })
    );
    assert_eq!(frame(EOF, main_bounds, fill(0)), Ok(vec![EOF, 0, 0, 0, 0]));
}
