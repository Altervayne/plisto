/*
 * Healthy helpers against the audio rate: each test format played to its end in real time with a
 * small credit, so only the audio it delivers keeps it alive; and, run by hand, the helper's CPU
 * per second of audio on each, which the audio rate must exceed five times.
 */

use super::faulty::{body, item, Item};
use super::*;
use crate::audio::stream::test_containers::{m4a, M4a};
use crate::audio::stream::test_media::{flac_silence, mp3_silence, ogg_opus_bytes};
use crate::audio::stream::SPIN_AUDIO_MS_PER_SEC;

/// A test format and `secs` seconds of it.
fn media(format: &str, secs: usize) -> Vec<u8> {
    match format {
        "WAV 384 kHz x 8" => wav_bytes(384_000, 8, 384_000 * secs),
        // 4,096 frames a block.
        "FLAC 384 kHz x 8" => flac_silence(384_000, 8, secs * 384_000 / 4_096, 4_096),
        // 1,024 frames an AAC frame at 44.1 kHz.
        "M4A" => m4a(
            &M4a {
                frames: secs * 44_100 / 1_024,
                ..M4a::default()
            },
            &|_, p| p,
        ),
        // 20 ms a packet.
        "Ogg Opus stereo" => ogg_opus_bytes(0x0E, 2, secs * 50, 312),
        // 1,152 frames an MP3 frame at 44.1 kHz.
        "MP3" => mp3_silence(secs * 44_100 / 1_152),
        _ => unreachable!("{format}"),
    }
}

// Takes audio no faster than it plays until the item ends; returns the end.
fn play_in_real_time(it: &Item) -> DecodeEnd {
    let started = Instant::now();
    let deadline = started + WAIT * 6;
    let mut played = Duration::ZERO;
    loop {
        while played <= started.elapsed() {
            match it.reader.try_next() {
                Some(Segment::Chunk(chunk)) => {
                    played += Duration::from_secs_f64(
                        chunk.frames() as f64 / f64::from(chunk.spec.sample_rate),
                    );
                }
                Some(_) => {}
                None => break,
            }
        }
        if let Ok(end) = it.ended.try_recv() {
            return end;
        }
        assert!(Instant::now() < deadline, "the item never ended");
        thread::sleep(Duration::from_millis(5));
    }
}

fn plays_to_its_end(format: &str) {
    let control = Arc::new(StreamControl::new());
    // A credit below what the whole item costs to decode, so the audio it delivers must pay for
    // it, yet above what the helper spends decoding its own queue's worth ahead while main takes
    // nothing, which nothing pays for until main takes it. The stall time is the app's, as a
    // loaded machine can keep a healthy helper waiting on CPU for seconds.
    let launch = Launch {
        spin: Duration::from_millis(2_500),
        cpu_tick: Duration::from_millis(250),
        ..Launch::default()
    };
    let it = item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&media(format, 10), &control),
    );
    assert_eq!(play_in_real_time(&it), DecodeEnd::Finished, "{format}");
}

#[test]
fn a_wav_at_the_largest_spec_plays_to_its_end() {
    plays_to_its_end("WAV 384 kHz x 8");
}

#[test]
fn a_flac_at_the_largest_spec_plays_to_its_end() {
    plays_to_its_end("FLAC 384 kHz x 8");
}

#[test]
fn an_m4a_plays_to_its_end() {
    plays_to_its_end("M4A");
}

#[test]
fn an_ogg_opus_plays_to_its_end() {
    plays_to_its_end("Ogg Opus stereo");
}

#[test]
fn an_mp3_plays_to_its_end() {
    plays_to_its_end("MP3");
}

#[test]
#[ignore = "measures the helper's CPU per second of audio on each test format"]
fn the_audio_rate_is_five_times_the_helper_cpu_per_audio_second() {
    let secs = 20;
    let mut worst = 0f64;
    for format in [
        "WAV 384 kHz x 8",
        "FLAC 384 kHz x 8",
        "M4A",
        "Ogg Opus stereo",
        "MP3",
    ] {
        let control = Arc::new(StreamControl::new());
        let (cpu_tx, cpu) = std::sync::mpsc::channel();
        let mut launch = Launch::default();
        launch.probe.cpu = Some(cpu_tx);
        let it = item(
            &DECODE_HELPER,
            launch,
            &control,
            body(&media(format, secs), &control),
        );
        let ready = cpu.recv_timeout(WAIT * 3).unwrap();
        let (end, frames) = it.drain(WAIT * 12);
        assert_eq!(end, DecodeEnd::Finished, "{format}");
        let used = cpu.recv_timeout(WAIT).unwrap().saturating_sub(ready);
        let per_sec = used.as_secs_f64() * 1_000.0 / secs as f64;
        eprintln!("helper CPU per audio second, {format}: {per_sec:.1} ms ({frames} frames)");
        worst = worst.max(per_sec);
    }
    eprintln!("worst {worst:.1} ms; audio rate {SPIN_AUDIO_MS_PER_SEC} ms");
    assert!(worst * 5.0 <= SPIN_AUDIO_MS_PER_SEC as f64);
}
