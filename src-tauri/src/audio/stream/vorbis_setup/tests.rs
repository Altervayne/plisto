use super::*;
use crate::audio::stream::isolate::alloc::{new_record, watch_this_thread};
use crate::audio::stream::test_containers::{vorbis_ident, vorbis_setup};
use std::sync::atomic::Ordering;
use symphonia::core::codecs::{CodecParameters, DecoderOptions, CODEC_TYPE_VORBIS};

// One book of `lens` (dense, unordered), one dimension, no lookup table, as setup fields.
fn book(lens: &[u8]) -> Vec<(u64, u32)> {
    let mut fields = vec![
        (0, 8),
        (0x56_4342, 24),
        (1, 16),
        (lens.len() as u64, 24),
        (0, 1),
        (0, 1),
    ];
    fields.extend(lens.iter().map(|&l| (l as u64 - 1, 5)));
    fields.push((0, 4));
    fields
}

// A complete code whose first `p` 16-bit prefixes each hold codewords of 17 to 24 bits, so each
// makes a second-level decoding block: 1 + ceil(p / 256) + p blocks in all.
fn deep_lens(p: usize) -> Vec<u8> {
    let mut lens = Vec::new();
    for _ in 0..p {
        lens.extend(17..=24u8);
        lens.push(24);
    }
    let groups = p.div_ceil(256);
    lens.extend(std::iter::repeat_n(16u8, groups * 256 - p));
    lens.extend(std::iter::repeat_n(8u8, 256 - groups));
    lens
}

#[test]
fn lookup1_follows_symphonia_and_refuses_what_would_trip_its_asserts() {
    assert_eq!(lookup1_values(81, 2), Ok(9));
    assert_eq!(lookup1_values(80, 2), Ok(8));
    assert_eq!(lookup1_values(1 << 16, 1), Ok(1 << 16));
    // Large dimensions overflow symphonia's integer check.
    assert_eq!(lookup1_values(1 << 16, 40), Err(Refused));
    // Every pair the caps admit with lookup type 1 either passes both asserts or is refused.
    for entries in [1u32, 2, 3, 7, 8, 27, 64, 81, 100, 125, 1_000, 4_096, 65_536] {
        for dims in 1..=16u32 {
            if let Ok(v) = lookup1_values(entries, dims) {
                assert!(v.pow(dims) <= entries);
                assert!((v as u64 + 1).pow(dims) > entries as u64);
            }
        }
    }
}

#[test]
fn sane_books_pass_and_huge_books_are_refused() {
    // 81 entries of 2 dimensions, lookup type 1 with 9 values of 4 bits. Lengths: a complete code
    // of one 1-bit, one 2-bit, ..., and two 7-bit codewords is padded by unused (sparse) entries.
    let mut fields = vec![(0, 8), (0x56_4342, 24), (2, 16), (81, 24), (0, 1), (1, 1)];
    for i in 0..81u64 {
        if i < 7 {
            fields.extend([(1, 1), (i, 5)]);
        } else if i == 7 {
            fields.extend([(1, 1), (6, 5)]);
        } else {
            fields.push((0, 1));
        }
    }
    fields.extend([(1, 4), (0, 32), (0, 32), (3, 4), (0, 1)]);
    fields.extend(std::iter::repeat_n((5, 4), 9));
    assert_eq!(check_setup(&vorbis_setup(&fields)), Ok(()));

    // An ordered book claiming 2^24 entries of 2^16 dimensions in a few bytes.
    let huge = vorbis_setup(&[
        (0, 8),
        (0x56_4342, 24),
        (0xFFFF, 16),
        (0xFF_FFFF, 24),
        (1, 1),
        (0, 5),
        (0xFF_FFFF, 24),
        (2, 4),
    ]);
    assert_eq!(check_setup(&huge), Err(Refused));

    // An ordered book whose lengths run past 32 bits.
    let long = vorbis_setup(&[
        (0, 8),
        (0x56_4342, 24),
        (1, 16),
        (2, 24),
        (1, 1),
        (31, 5),
        (0, 2),
        (2, 2),
    ]);
    assert_eq!(check_setup(&long), Err(Refused));

    // A bad sync, a truncated book, an unknown lookup type.
    assert_eq!(
        check_setup(&vorbis_setup(&[(0, 8), (0x12_3456, 24)])),
        Err(Refused)
    );
    let mut bad = book(&[1, 1]);
    *bad.last_mut().unwrap() = (3, 4);
    assert_eq!(check_setup(&vorbis_setup(&bad)), Err(Refused));
}

#[test]
fn decoding_blocks_are_counted_as_symphonia_builds_them() {
    let (mut codes, mut scratch) = (Vec::new(), Vec::new());
    for p in [1, 255, 256, 257, 1_000] {
        let lens = deep_lens(p);
        assert_eq!(codewords(&lens, &mut codes), Ok(Some(())), "{p}");
        assert_eq!(
            blocks(&lens, &codes, &mut scratch),
            1 + p.div_ceil(256) + p,
            "{p}"
        );
    }
    let admitted = deep_lens(VORBIS_BOOK_BLOCKS_MAX - 5);
    assert_eq!(check_setup(&vorbis_setup(&book(&admitted))), Ok(()));
    let over = deep_lens(VORBIS_BOOK_BLOCKS_MAX);
    assert_eq!(check_setup(&vorbis_setup(&book(&over))), Err(Refused));
}

// Builds symphonia's real Vorbis decoder from an identification header and `setup` on a watched
// thread, and returns the largest single allocation it made.
fn decoder_peak(setup: Vec<u8>) -> usize {
    let mut extra = vorbis_ident();
    extra.extend(setup);
    let record = new_record();
    std::thread::spawn(move || {
        watch_this_thread(record);
        let mut params = CodecParameters::new();
        params
            .for_codec(CODEC_TYPE_VORBIS)
            .with_extra_data(extra.into_boxed_slice());
        // The setup ends after its codebooks, so the decoder fails once they are built.
        let _ = symphonia::default::get_codecs().make(&params, &DecoderOptions::default());
    })
    .join()
    .unwrap();
    record.load(Ordering::Relaxed)
}

#[test]
fn the_worst_admitted_codebook_stays_within_its_stated_bound() {
    let lens = deep_lens(VORBIS_BOOK_BLOCKS_MAX - 5);
    let setup = vorbis_setup(&book(&lens));
    assert_eq!(check_setup(&setup), Ok(()));
    let peak = decoder_peak(setup);
    // 1,024 blocks of 256 entries of 8 bytes, in a table grown by doubling.
    let bound = 2 * VORBIS_BOOK_BLOCKS_MAX * 256 * 8;
    assert!(
        peak > bound / 4,
        "the decoder built the table: {peak} bytes"
    );
    assert!(peak <= bound, "largest allocation {peak} bytes");
}
