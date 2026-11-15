use super::*;
use crate::audio::stream::bytes::{byte_ring, growing_buffer, ByteRing, WriteError};
use crate::audio::stream::pcm::{pcm_queue, PcmReader, Seam, Segment};
use crate::audio::stream::test_media::*;
use crate::audio::stream::{spawn_isolated, StreamControl, START_MS};
use std::cell::Cell;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use symphonia::core::probe::Hint;

mod ends;
mod hostile;
mod hostile_containers;
mod hostile_ogg;
mod isolated;
mod seek;

const DEADLINE: Duration = Duration::from_secs(10);

thread_local! {
    // Whether `start` on this test's thread decodes in a decode helper process.
    static ISOLATED: Cell<bool> = const { Cell::new(false) };
}

/// Runs `test` with its decoding in a decode helper: the same input must queue the same segments
/// and end the same way as in-process.
fn isolated(test: fn()) {
    ISOLATED.set(true);
    test();
}

// What the queue delivered, with consecutive chunks of one spec merged into a frame count.
#[derive(Debug, PartialEq)]
enum Ev {
    Frames(AudioSpec, usize),
    Break(Seam),
    End,
}

fn summarize(segments: Vec<Segment>) -> Vec<Ev> {
    let mut out: Vec<Ev> = Vec::new();
    for s in segments {
        match s {
            Segment::Chunk(c) => {
                let frames = c.frames();
                match out.last_mut() {
                    Some(Ev::Frames(spec, n)) if *spec == c.spec => *n += frames,
                    _ => out.push(Ev::Frames(c.spec, frames)),
                }
            }
            Segment::Break(seam) => out.push(Ev::Break(seam)),
            Segment::End => out.push(Ev::End),
        }
    }
    out
}

fn spec(sample_rate: u32, channels: u16) -> AudioSpec {
    AudioSpec {
        sample_rate,
        channels,
    }
}

/// A started decode thread, its queue reader and its end report.
struct Running {
    reader: PcmReader,
    ended: mpsc::Receiver<DecodeEnd>,
    handle: thread::JoinHandle<()>,
}

fn start(input: StreamInput, control: &Arc<StreamControl>) -> Running {
    let (queue, reader) = pcm_queue(Arc::clone(control));
    let (tx, ended) = mpsc::channel();
    let on_end = move |end| {
        let _ = tx.send(end);
    };
    let handle = if ISOLATED.get() {
        spawn_isolated(input, queue, on_end)
    } else {
        spawn_decoder(input, queue, on_end)
    }
    .unwrap();
    Running {
        reader,
        ended,
        handle,
    }
}

impl Running {
    // Drains the queue the way the audio thread will until the thread reports its end, then takes
    // what is left. Returns every segment and how the thread ended.
    fn finish(self) -> (Vec<Segment>, DecodeEnd) {
        // A helper decodes below normal priority under a one-core cap: on a loaded machine it
        // takes longer than the decode thread would.
        let allowed = if ISOLATED.get() { DEADLINE * 3 } else { DEADLINE };
        let deadline = Instant::now() + allowed;
        let mut segments = Vec::new();
        loop {
            assert!(Instant::now() < deadline, "the decode thread never ended");
            while let Some(s) = self.reader.try_next() {
                segments.push(s);
            }
            if let Ok(end) = self.ended.try_recv() {
                while let Some(s) = self.reader.try_next() {
                    segments.push(s);
                }
                self.handle.join().unwrap();
                return (segments, end);
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

fn decode_all(input: StreamInput, control: Arc<StreamControl>) -> (Vec<Segment>, DecodeEnd) {
    start(input, &control).finish()
}

// Polls `cond` until it holds, failing the test past `DEADLINE`.
fn wait_for(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + DEADLINE;
    while !cond() {
        assert!(Instant::now() < deadline, "{what}");
        thread::sleep(Duration::from_millis(1));
    }
}

// A ring fed from a thread in `step`-byte writes, waiting on `Full` as the push path does. The
// feeder finishes the ring, or with `drop_writer` lets it go without a finish.
fn feed_ring(
    bytes: Vec<u8>,
    step: usize,
    capacity: usize,
    control: &Arc<StreamControl>,
    drop_writer: bool,
) -> ByteRingFeed {
    let (writer, ring) = byte_ring(capacity, Arc::clone(control));
    let feeder = thread::spawn(move || {
        for piece in bytes.chunks(step) {
            loop {
                match writer.try_write(piece) {
                    Ok(_) => break,
                    Err(WriteError::Full { .. }) => thread::sleep(Duration::from_millis(1)),
                    Err(_) => return,
                }
            }
        }
        if !drop_writer {
            writer.finish();
        }
    });
    ByteRingFeed { ring, feeder }
}

fn fed_ring(
    bytes: Vec<u8>,
    step: usize,
    capacity: usize,
    control: &Arc<StreamControl>,
) -> ByteRingFeed {
    feed_ring(bytes, step, capacity, control, false)
}

struct ByteRingFeed {
    ring: ByteRing,
    feeder: thread::JoinHandle<()>,
}

fn media(source: impl MediaSource + 'static, hint: Option<&'static str>) -> StreamInput {
    StreamInput::Media {
        source: Box::new(source),
        hint,
    }
}

fn frames_of(segments: &[Segment]) -> usize {
    segments
        .iter()
        .map(|s| match s {
            Segment::Chunk(c) => c.frames(),
            _ => 0,
        })
        .sum()
}

// A content type and the hint or refusal it maps to.
type HintCase = (
    Option<&'static str>,
    Result<Option<&'static str>, Unsupported>,
);

#[test]
fn content_types_map_to_hints_and_refusals() {
    let cases: &[HintCase] = &[
        (None, Ok(None)),
        (Some("audio/mpeg"), Ok(Some("mp3"))),
        (Some("Audio/MP3; charset=x"), Ok(Some("mp3"))),
        (Some("audio/aac"), Ok(Some("aac"))),
        (Some("audio/aacp"), Ok(Some("aac"))),
        (Some("audio/x-aac"), Ok(Some("aac"))),
        (Some("audio/ogg"), Ok(Some("ogg"))),
        (Some("application/ogg"), Ok(Some("ogg"))),
        (Some("audio/opus"), Ok(Some("ogg"))),
        (Some("audio/flac"), Ok(Some("flac"))),
        (Some("audio/x-flac"), Ok(Some("flac"))),
        (Some("audio/wav"), Ok(Some("wav"))),
        (Some("audio/x-wav"), Ok(Some("wav"))),
        (Some("audio/wave"), Ok(Some("wav"))),
        (Some("audio/mp4"), Ok(Some("m4a"))),
        (Some("audio/x-m4a"), Ok(Some("m4a"))),
        (Some("application/octet-stream"), Ok(None)),
        (Some(""), Ok(None)),
        (Some("audio/x-mpegurl"), Err(Unsupported::Playlist)),
        (Some("audio/mpegurl"), Err(Unsupported::Playlist)),
        (
            Some("application/vnd.apple.mpegurl"),
            Err(Unsupported::Playlist),
        ),
        (Some("application/x-mpegurl"), Err(Unsupported::Playlist)),
        (Some("audio/x-scpls"), Err(Unsupported::Playlist)),
        (Some("application/pls+xml"), Err(Unsupported::Playlist)),
        (Some("application/xspf+xml"), Err(Unsupported::Playlist)),
        (Some("application/dash+xml"), Err(Unsupported::Playlist)),
        (
            Some("text/html; charset=utf-8"),
            Err(Unsupported::ContentType),
        ),
        (Some("text/plain"), Err(Unsupported::ContentType)),
        (Some("application/json"), Err(Unsupported::ContentType)),
    ];
    for (ct, want) in cases {
        assert_eq!(hint_for_content_type(*ct), *want, "{ct:?}");
    }
    assert_eq!(hint_for_push(PushFormat::Mp3), Some("mp3"));
    assert_eq!(hint_for_push(PushFormat::AacAdts), Some("aac"));
    assert_eq!(hint_for_push(PushFormat::Ogg), Some("ogg"));
    assert_eq!(hint_for_push(PushFormat::Flac), Some("flac"));
    let pcm = PushFormat::PcmS16le {
        rate: 48_000,
        channels: 2,
    };
    assert_eq!(hint_for_push(pcm), None);
}

#[test]
fn decodes_wav_through_a_growing_buffer() {
    let control = Arc::new(StreamControl::new());
    let bytes = wav_bytes(22_050, 2, 5_000);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    let feeder = thread::spawn(move || {
        for piece in bytes.chunks(997) {
            writer.write(piece).unwrap();
            thread::sleep(Duration::from_micros(200));
        }
        writer.finish();
    });
    let (segments, end) = decode_all(media(body, Some("wav")), control);
    feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![Ev::Frames(spec(22_050, 2), 5_000), Ev::End]
    );
}

#[test]
fn decodes_ogg_opus_through_a_ring_in_small_writes() {
    let control = Arc::new(StreamControl::new());
    let bytes = ogg_opus_bytes(0x0A0B_0C0D, 2, 60, 312);
    let feed = fed_ring(bytes, 7, 4_096, &control);
    let (segments, end) = decode_all(media(feed.ring, Some("ogg")), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![Ev::Frames(spec(48_000, 2), 60 * OPUS_FRAME - 312), Ev::End]
    );
}

#[test]
fn decodes_flac_unseekable() {
    let control = Arc::new(StreamControl::new());
    let blocks = 12;
    let feed = fed_ring(flac_bytes(blocks, FLAC_BLOCK), 1_000, 8_192, &control);
    let (segments, end) = decode_all(media(feed.ring, None), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);

    // Verbatim subframes decode bit-exact.
    let mut samples = Vec::new();
    for s in &segments {
        if let Segment::Chunk(c) = s {
            assert_eq!(c.spec, spec(44_100, 1));
            samples.extend_from_slice(&c.samples);
        }
    }
    assert_eq!(samples.len(), blocks * FLAC_BLOCK);
    for (i, s) in samples.iter().enumerate() {
        assert_eq!(*s, ramp(i) as f32 / 32_768.0, "sample {i}");
    }
    assert!(matches!(segments.last(), Some(Segment::End)));
}

#[test]
fn tiny_blocks_still_reach_the_start_threshold() {
    // 16-frame blocks: one segment per block would fill the channel near 1.5 s and never reach
    // `START_MS` with nobody reading.
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(flac_bytes(6_000, 16), 4_096, 64 * 1_024, &control);
    let running = start(media(feed.ring, Some("flac")), &control);
    wait_for("never ready", || control.is_ready(START_MS));
    control.cancel();
    assert_eq!(
        running.ended.recv_timeout(Duration::from_secs(2)),
        Ok(DecodeEnd::Cancelled)
    );
    running.handle.join().unwrap();
    feed.feeder.join().unwrap();
}

#[test]
fn decodes_adts_aac_unseekable() {
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(adts_silence(40), 5, 1_024, &control);
    let (segments, end) = decode_all(media(feed.ring, Some("aac")), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![Ev::Frames(spec(44_100, 1), 40 * 1_024), Ev::End]
    );
}

#[test]
fn decodes_mp3_unseekable() {
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(mp3_silence(30), 101, 2_048, &control);
    let (segments, end) = decode_all(media(feed.ring, Some("mp3")), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![Ev::Frames(spec(44_100, 1), 30 * MP3_FRAME), Ev::End]
    );
}

// A real MP3 through a ring in small writes, from the file PLISTO_TEST_MP3 names.
#[test]
#[ignore = "needs PLISTO_TEST_MP3 set to a local MP3"]
fn decodes_a_local_mp3_through_a_ring() {
    let path = std::env::var("PLISTO_TEST_MP3").expect("PLISTO_TEST_MP3 names an MP3");
    let bytes = std::fs::read(path).expect("reads the MP3");
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(bytes, 1_399, 64 * 1_024, &control);
    let (segments, end) = decode_all(media(feed.ring, Some("mp3")), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert!(frames_of(&segments) > 0, "decodes audio");
}

#[test]
fn pcm_s16le_converts_in_the_declared_spec() {
    let control = Arc::new(StreamControl::new());
    let declared = spec(22_050, 2);
    let values: Vec<i16> = (0..10_000)
        .map(|i| match i % 4 {
            0 => i16::MIN,
            1 => i16::MAX,
            2 => 0,
            _ => (i as i16).wrapping_mul(7),
        })
        .collect();
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    // Odd writes split frames and samples across writes.
    let feed = fed_ring(bytes, 333, 4_096, &control);
    let input = StreamInput::PcmS16le {
        source: Box::new(feed.ring),
        spec: declared,
    };
    let (segments, end) = decode_all(input, control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);

    let mut samples = Vec::new();
    for s in &segments {
        if let Segment::Chunk(c) = s {
            assert_eq!(c.spec, declared);
            assert_eq!(c.samples.len() % 2, 0, "whole frames only");
            samples.extend_from_slice(&c.samples);
        }
    }
    let want: Vec<f32> = values.iter().map(|&v| v as f32 / 32_768.0).collect();
    assert_eq!(samples, want);
    assert_eq!(samples[0], -1.0);
    assert!(matches!(segments.last(), Some(Segment::End)));
}

#[test]
fn chained_ogg_rebuilds_and_pushes_a_break() {
    let control = Arc::new(StreamControl::new());
    let mut bytes = ogg_opus_bytes(0x1111, 1, 20, 312);
    bytes.extend(ogg_opus_bytes(0x2222, 2, 30, 120));
    let feed = fed_ring(bytes, 64, 4_096, &control);
    let (segments, end) = decode_all(media(feed.ring, Some("ogg")), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![
            Ev::Frames(spec(48_000, 1), 20 * OPUS_FRAME - 312),
            Ev::Break(Seam::Chain),
            Ev::Frames(spec(48_000, 2), 30 * OPUS_FRAME - 120),
            Ev::End,
        ]
    );
}

#[test]
fn open_by_path_is_unchanged() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("plisto_stream_open_{}_{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tone.wav");
    let bytes = wav_bytes(44_100, 2, 3_000);
    std::fs::write(&path, &bytes).unwrap();

    let mut by_path = Decoder::open(&path).expect("opens by path");
    let control = Arc::new(StreamControl::new());
    let (writer, body) = growing_buffer(bytes.len() as u64, control);
    writer.write(&bytes).unwrap();
    writer.finish();
    let mut hint = Hint::new();
    hint.with_extension("wav");
    let mut by_media = Decoder::open_media(Box::new(body), hint).expect("opens by media");

    assert_eq!(by_path.spec(), by_media.spec());
    assert_eq!(by_path.total_frames(), by_media.total_frames());
    loop {
        match (by_path.next_packet(), by_media.next_packet()) {
            (Some(a), Some(b)) => assert_eq!(a.samples, b.samples),
            (None, None) => break,
            _ => panic!("the two opens decode different lengths"),
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// A finished ring holding `bytes`.
fn ring_of(bytes: &[u8]) -> ByteRing {
    let (writer, ring) = byte_ring(bytes.len().max(1), Arc::new(StreamControl::new()));
    writer.try_write(bytes).unwrap();
    writer.finish();
    ring
}

fn decode_end(input: StreamInput) -> DecodeEnd {
    decode_all(input, Arc::new(StreamControl::new())).1
}

#[test]
fn refusals_name_format_and_codec() {
    assert_eq!(
        decode_end(media(ring_of(b"this is not audio, only text"), None)),
        DecodeEnd::Failed(Unsupported::Format)
    );
    // The container probes, but no backend decodes three-channel Opus.
    assert_eq!(
        decode_end(media(ring_of(&surround_opus_ogg()), Some("ogg"))),
        DecodeEnd::Failed(Unsupported::Codec)
    );
}

#[test]
fn html_under_an_audio_hint_is_refused_within_the_probe_limit() {
    // An endless HTML body labelled `audio/mpeg`: the probe gives up after its 1 MiB search limit,
    // so the thread ends with the writer still open.
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(64 * 1_024, Arc::clone(&control));
    let feeder = thread::spawn(move || {
        let page = b"<html><body><p>Not audio at all.</p></body></html>\n".repeat(64);
        let mut sent = 0usize;
        while sent < 8 << 20 {
            match writer.try_write(&page) {
                Ok(_) => sent += page.len(),
                Err(WriteError::Full { .. }) => thread::sleep(Duration::from_millis(1)),
                Err(_) => break,
            }
        }
        sent
    });
    let hint = hint_for_content_type(Some("audio/mpeg")).unwrap();
    let (_, end) = decode_all(media(ring, hint), control);
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
    let sent = feeder.join().unwrap();
    assert!(sent < 2 << 20, "read {sent} bytes before refusing");
}

#[test]
fn specs_outside_the_limits_are_refused_as_format() {
    let pcm = |sample_rate, channels| StreamInput::PcmS16le {
        source: Box::new(ring_of(&[0; 64])),
        spec: spec(sample_rate, channels),
    };
    for (rate, channels) in [
        (48_000, 0),
        (48_000, 3),
        (48_000, 65_535),
        (4_000, 2),
        (400_000, 1),
    ] {
        assert_eq!(
            decode_end(pcm(rate, channels)),
            DecodeEnd::Failed(Unsupported::Format),
            "{rate} Hz, {channels} ch"
        );
    }
    // A container declaring too many channels or too low a rate never reaches a decoder.
    assert_eq!(
        decode_end(media(ring_of(&wav_bytes(44_100, 9, 100)), Some("wav"))),
        DecodeEnd::Failed(Unsupported::Format)
    );
    assert_eq!(
        decode_end(media(ring_of(&wav_bytes(4_000, 1, 100)), Some("wav"))),
        DecodeEnd::Failed(Unsupported::Format)
    );
}

// An Ogg Opus stream declaring three channels (mapping family 1), with one placeholder packet.
fn surround_opus_ogg() -> Vec<u8> {
    use ogg::writing::{PacketWriteEndInfo, PacketWriter};
    let mut head = b"OpusHead".to_vec();
    head.extend_from_slice(&[1, 3]);
    head.extend_from_slice(&312u16.to_le_bytes());
    head.extend_from_slice(&48_000u32.to_le_bytes());
    head.extend_from_slice(&0u16.to_le_bytes());
    // Family 1; two streams, one coupled; channel table.
    head.extend_from_slice(&[1, 2, 1, 0, 2, 1]);
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&0u32.to_le_bytes());
    tags.extend_from_slice(&0u32.to_le_bytes());
    let mut w = PacketWriter::new(Vec::new());
    w.write_packet(head, 9, PacketWriteEndInfo::EndPage, 0)
        .unwrap();
    w.write_packet(tags, 9, PacketWriteEndInfo::EndPage, 0)
        .unwrap();
    w.write_packet(
        vec![0xFC, 0xFF, 0xFE],
        9,
        PacketWriteEndInfo::EndStream,
        1_272,
    )
    .unwrap();
    w.into_inner()
}
