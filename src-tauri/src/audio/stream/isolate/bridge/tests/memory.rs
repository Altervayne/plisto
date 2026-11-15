/*
 * The helper's memory against its cap: what the worst legitimate inputs commit, measured through
 * the job, and what the limits admit at most, summed.
 */

use super::faulty::{body, item, Item};
use super::*;
use crate::audio::stream::test_containers::{m4a, M4a};
use crate::audio::stream::test_media::flac_silence;
use crate::audio::stream::{
    MAX_CHANNELS, MOOV_MAX, MP4_ENTRIES_MAX, MP4_ITEM_MAX, OGG_PACKET_MAX, PCM_MAX_MS, RATES,
};

/// The largest audio packet symphonia's Ogg reader holds.
const OGG_AUDIO_PACKET_MAX: usize = 16 << 20;
/// What a helper commits before it decodes anything, rounded up from the measured 3.5 MiB.
const HELPER_BASE: usize = 4 << 20;

// A helper decoding `bytes` reports its peak to the returned receiver once the item ends.
fn measured(bytes: &[u8]) -> (Item, std::sync::mpsc::Receiver<usize>) {
    let control = Arc::new(StreamControl::new());
    let (peak_tx, peak) = std::sync::mpsc::channel();
    let mut launch = Launch::default();
    launch.probe.peak = Some(peak_tx);
    (
        item(&DECODE_HELPER, launch, &control, body(bytes, &control)),
        peak,
    )
}

fn mib(bytes: usize) -> f64 {
    bytes as f64 / f64::from(1 << 20)
}

// Lets main's queue fill and stay full for a while, then plays the item out; returns its peak.
fn peak_behind_a_full_queue(bytes: &[u8], frames: usize) -> usize {
    let (it, peak) = measured(bytes);
    let deadline = Instant::now() + WAIT * 6;
    while it.control.buffered_ms() < PCM_MAX_MS - 500 {
        assert!(Instant::now() < deadline, "the queue never filled");
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_secs(2));
    assert_eq!(it.drain(WAIT * 6), (DecodeEnd::Finished, frames));
    peak.recv_timeout(WAIT).unwrap()
}

#[test]
fn legit_worst_case_peak_is_under_half_the_cap() {
    let (rate, channels) = (384_000, 8);
    // 10 s of the largest spec the limits admit. As a WAV every block of PCM costs a read from
    // main, so the helper's own queue stays nearly empty behind a full one in main.
    let frames = rate as usize * 10;
    let wav = peak_behind_a_full_queue(&wav_bytes(rate, channels, frames), frames);
    // As constant FLAC a few bytes decode to a whole block, so the helper's own queue fills.
    let (blocks, block) = (938, 4_096);
    let flac =
        peak_behind_a_full_queue(&flac_silence(rate, channels, blocks, block), blocks * block);

    // As many sample table entries as the guard admits and a 7 MiB cover in a moov just under its
    // cap: every table is built at the opening. Ended once audio comes.
    let spec = M4a {
        frames: MP4_ENTRIES_MAX as usize - 1,
        cover: 7 << 20,
        ..M4a::default()
    };
    let (it, peak) = measured(&m4a(&spec, &|_, p| p));
    let deadline = Instant::now() + WAIT * 6;
    while it.control.buffered_ms() == 0 {
        assert!(
            it.ended.try_recv().is_err(),
            "the M4A ended before its audio"
        );
        assert!(Instant::now() < deadline, "no audio came");
        thread::sleep(Duration::from_millis(10));
    }
    it.control.cancel();
    assert_eq!(it.ended.recv_timeout(WAIT), Ok(DecodeEnd::Cancelled));
    let tables = peak.recv_timeout(WAIT).unwrap();

    eprintln!(
        "helper peak: {:.1} MiB WAV, {:.1} MiB FLAC at {rate} Hz x {channels} ch, {:.1} MiB M4A \
         with full tables and cover; cap {} MiB",
        mib(wav),
        mib(flac),
        mib(tables),
        HELPER_MEMORY_MAX >> 20
    );
    let peak = wav.max(flac).max(tables);
    assert!(peak * 2 <= HELPER_MEMORY_MAX, "committed {peak} bytes");
}

#[test]
fn the_admitted_worst_case_is_under_half_the_cap() {
    // The helper's own queue full at the largest format the limits admit, as f32 samples.
    let pcm = PCM_MAX_MS as usize * *RATES.end() as usize / 1_000 * usize::from(MAX_CHANNELS) * 4;
    // An MP4 read whole into its moov, its tables at most twice the moov once expanded, and its
    // largest metadata item counted again on top.
    let mp4 = 3 * MOOV_MAX as usize + MP4_ITEM_MAX as usize;
    // An Ogg stream's largest header packet and largest audio packet at once.
    let ogg = OGG_PACKET_MAX + OGG_AUDIO_PACKET_MAX;
    let worst = HELPER_BASE + pcm + mp4.max(ogg);
    eprintln!(
        "admitted worst case: {:.1} MiB ({:.1} MiB queue, {:.1} MiB parse state); cap {} MiB",
        mib(worst),
        mib(pcm),
        mib(mp4.max(ogg)),
        HELPER_MEMORY_MAX >> 20
    );
    assert!(worst * 2 <= HELPER_MEMORY_MAX, "{worst} bytes");
}
