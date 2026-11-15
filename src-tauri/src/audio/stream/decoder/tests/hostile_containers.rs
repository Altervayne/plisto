use super::hostile::{measure, ALLOC_BOUND};
use super::*;
use crate::audio::stream::bytes::GrowingWriter;
use crate::audio::stream::test_containers::*;
use crate::audio::stream::OGG_PACKET_MAX;

// Plays Ogg `bytes` from a ring whose writer stays open; returns the end and the largest allocation.
fn play_ogg(bytes: &[u8]) -> (DecodeEnd, usize) {
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(bytes.len() + 1, Arc::clone(&control));
    writer.try_write(bytes).unwrap();
    let measured = measure(ring, Some("ogg"), &control);
    drop(writer);
    measured
}

// Plays an MP4 from a growing buffer holding all of `bytes`, finished only when `finish`.
fn play_mp4(bytes: &[u8], finish: bool) -> (DecodeEnd, usize) {
    let control = Arc::new(StreamControl::new());
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(bytes).unwrap();
    let held: Option<GrowingWriter> = if finish {
        writer.finish();
        None
    } else {
        Some(writer)
    };
    let measured = measure(body, Some("m4a"), &control);
    drop(held);
    measured
}

fn assert_refused((end, largest): (DecodeEnd, usize), what: &str) {
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format), "{what}");
    assert!(largest < ALLOC_BOUND, "{what}: allocated {largest} bytes");
}

fn comment(prefix: &[u8], lens: &[u32]) -> Vec<u8> {
    let mut v = prefix.to_vec();
    v.extend(comment_body(lens));
    v
}

fn stream(ident: &[u8], packets: &[&[u8]]) -> Vec<u8> {
    let mut v = ogg_page(11, 0, FIRST, &[ident], false);
    v.extend(ogg_page(11, 1, 0, packets, false));
    v
}

#[test]
fn an_ogg_comment_claiming_gigabytes_is_refused_in_every_mapping() {
    let huge = [0xFFFF_FFF0];
    let vorbis = stream(&vorbis_ident(), &[&comment(b"\x03vorbis", &huge)]);
    assert_refused(play_ogg(&vorbis), "vorbis");
    let opus = stream(&opus_head(), &[&comment(b"OpusTags", &huge)]);
    assert_refused(play_ogg(&opus), "opus");
    let flac = stream(&flac_ogg_ident(), &[&comment(&[0x04, 0, 0, 0x20], &huge)]);
    assert_refused(play_ogg(&flac), "flac");
}

#[test]
fn a_vorbis_codebook_of_2_24_entries_by_2_16_dimensions_is_refused() {
    let setup = vorbis_setup(&[
        (0, 8),
        (0x56_4342, 24),
        (0xFFFF, 16),
        (0xFF_FFFF, 24),
        (1, 1),
        (0, 5),
        (0xFF_FFFF, 24),
        (2, 4),
        (0, 64),
        (15, 4),
        (0, 1),
    ]);
    let bytes = stream(&vorbis_ident(), &[&comment(b"\x03vorbis", &[]), &setup]);
    assert_refused(play_ogg(&bytes), "codebook");
}

#[test]
fn an_endless_ogg_packet_stops_at_the_cap() {
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(1 << 20, Arc::clone(&control));
    let feeder = thread::spawn(move || {
        // A Vorbis comment header that never ends.
        let mut page = ogg_page(11, 0, FIRST, &[&vorbis_ident()], false);
        let mut first = vec![0u8; 255 * 255];
        first[..7].copy_from_slice(b"\x03vorbis");
        let chunk = vec![0u8; 255 * 255];
        let mut seq = 1;
        loop {
            loop {
                match writer.try_write(&page) {
                    Ok(_) => break,
                    Err(WriteError::Full { .. }) => thread::sleep(Duration::from_millis(1)),
                    Err(_) => return,
                }
            }
            page = if seq == 1 {
                ogg_page(11, seq, 0, &[&first], true)
            } else {
                ogg_page(11, seq, CONTINUED, &[&chunk], true)
            };
            seq += 1;
        }
    });
    let (end, largest) = measure(ring, Some("ogg"), &control);
    feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
    // symphonia buffers the unfinished packet up to the cap before the guard refuses it.
    assert!(
        largest < OGG_PACKET_MAX + ALLOC_BOUND,
        "allocated {largest} bytes"
    );
}

#[test]
fn a_hostile_second_link_in_a_chain_is_refused_mid_stream() {
    let mut bytes = ogg_opus_bytes(0x21, 1, 30, 312);
    bytes.extend(stream(
        &vorbis_ident(),
        &[&comment(b"\x03vorbis", &[0xFFFF_FFF0])],
    ));
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(bytes.len() + 1, Arc::clone(&control));
    writer.try_write(&bytes).unwrap();
    let running = start(media(ring, Some("ogg")), &control);
    let (segments, end) = running.finish();
    drop(writer);
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
    assert!(frames_of(&segments) > 0, "the first link played");
}

fn keep(_: &[u8; 4], p: Vec<u8>) -> Vec<u8> {
    p
}

fn table(count: u32, header: &[u8]) -> Vec<u8> {
    let mut v = vec![0u8; 4];
    v.extend_from_slice(header);
    v.extend_from_slice(&count.to_be_bytes());
    v
}

#[test]
fn mp4_counted_tables_claiming_billions_are_refused() {
    let cases: [(&[u8; 4], Vec<u8>, M4a); 6] = [
        (b"stsz", table(0xFFFF_FFFF, &[0; 4]), M4a::default()),
        (b"stco", table(0xFFFF_FFFF, &[]), M4a::default()),
        (b"stts", table(0xFFFF_FFFF, &[]), M4a::default()),
        (b"stsc", table(0xFFFF_FFFF, &[]), M4a::default()),
        (
            b"co64",
            table(0xFFFF_FFFF, &[]),
            M4a {
                co64: true,
                ..M4a::default()
            },
        ),
        (
            b"elst",
            table(0xFFFF_FFFF, &[]),
            M4a {
                edit_list: true,
                ..M4a::default()
            },
        ),
    ];
    for (kind, payload, spec) in cases {
        let file = m4a(&spec, &|k, p| if k == kind { payload.clone() } else { p });
        assert_refused(play_mp4(&file, false), &String::from_utf8_lossy(kind));
    }
}

#[test]
fn mp4_boxes_read_whole_are_refused_past_their_bounds() {
    let short_hdlr = m4a(&M4a::default(), &|k, p| {
        if k == b"hdlr" {
            vec![0; 8]
        } else {
            p
        }
    });
    assert_refused(play_mp4(&short_hdlr, false), "hdlr");

    let mut long_data = m4a(
        &M4a {
            cover: 16,
            ..M4a::default()
        },
        &keep,
    );
    grow_atom(&mut long_data, b"data", 0x7FFF_0000);
    assert_refused(play_mp4(&long_data, false), "ilst data");

    let esds = vec![0, 0, 0, 0, 0x03, 0x8F, 0xFF, 0xFF, 0x7F, 0, 1, 0];
    let file = m4a(&M4a::default(), &|k, p| {
        if k == b"esds" {
            esds.clone()
        } else {
            p
        }
    });
    assert_refused(play_mp4(&file, false), "esds");

    let alac = M4a {
        alac_frame: Some(0xFFFF_FFFF),
        ..M4a::default()
    };
    assert_refused(play_mp4(&m4a(&alac, &keep), false), "alac");

    let mut big = table(1, &[0; 4]);
    big.extend_from_slice(&0x4000_0000u32.to_be_bytes());
    let file = m4a(&M4a::default(), &|k, p| {
        if k == b"stsz" {
            big.clone()
        } else {
            p
        }
    });
    assert_refused(play_mp4(&file, false), "sample");
}

#[test]
fn a_hostile_moov_at_the_end_is_refused() {
    let spec = M4a {
        moov_last: true,
        ..M4a::default()
    };
    let file = m4a(&spec, &|k, p| {
        if k == b"stco" {
            table(0xFFFF_FFFF, &[])
        } else {
            p
        }
    });
    assert_refused(play_mp4(&file, false), "moov at the end");
}

#[test]
fn mp4_on_a_ring_is_refused() {
    let file = m4a(&M4a::default(), &keep);
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(file.len() + 1, Arc::clone(&control));
    writer.try_write(&file).unwrap();
    writer.finish();
    let (_, end) = start(media(ring, Some("m4a")), &control).finish();
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format));
}

#[test]
fn an_m4a_with_cover_art_plays_from_either_end() {
    let cover = 2 << 20;
    for moov_last in [false, true] {
        let spec = M4a {
            frames: 30,
            cover,
            moov_last,
            ..M4a::default()
        };
        let (segments, end) = {
            let control = Arc::new(StreamControl::new());
            let file = m4a(&spec, &keep);
            let (writer, body) = growing_buffer(file.len() as u64, Arc::clone(&control));
            writer.write(&file).unwrap();
            writer.finish();
            start(media(body, Some("m4a")), &control).finish()
        };
        assert_eq!(end, DecodeEnd::Finished, "moov last: {moov_last}");
        assert_eq!(
            summarize(segments),
            vec![Ev::Frames(spec_of(44_100, 1), 30 * 1_024), Ev::End],
            "moov last: {moov_last}"
        );
    }
    // The cover is read whole: the one allocation above the usual bound, and within cover + 1 MiB.
    let file = m4a(
        &M4a {
            cover,
            ..M4a::default()
        },
        &keep,
    );
    let (end, largest) = play_mp4(&file, true);
    assert_eq!(end, DecodeEnd::Finished);
    assert!(largest < cover + ALLOC_BOUND, "allocated {largest} bytes");
}

fn spec_of(rate: u32, channels: u16) -> AudioSpec {
    spec(rate, channels)
}

// The refusals above, with the decoding in a decode helper: the guards run there too.
mod isolated {
    use super::super::isolated;

    #[test]
    fn an_ogg_comment_claiming_gigabytes_is_refused_in_every_mapping() {
        isolated(super::an_ogg_comment_claiming_gigabytes_is_refused_in_every_mapping);
    }

    #[test]
    fn a_vorbis_codebook_of_2_24_entries_by_2_16_dimensions_is_refused() {
        isolated(super::a_vorbis_codebook_of_2_24_entries_by_2_16_dimensions_is_refused);
    }

    #[test]
    fn an_endless_ogg_packet_stops_at_the_cap() {
        isolated(super::an_endless_ogg_packet_stops_at_the_cap);
    }

    #[test]
    fn a_hostile_second_link_in_a_chain_is_refused_mid_stream() {
        isolated(super::a_hostile_second_link_in_a_chain_is_refused_mid_stream);
    }

    #[test]
    fn mp4_counted_tables_claiming_billions_are_refused() {
        isolated(super::mp4_counted_tables_claiming_billions_are_refused);
    }

    #[test]
    fn mp4_boxes_read_whole_are_refused_past_their_bounds() {
        isolated(super::mp4_boxes_read_whole_are_refused_past_their_bounds);
    }

    #[test]
    fn a_hostile_moov_at_the_end_is_refused() {
        isolated(super::a_hostile_moov_at_the_end_is_refused);
    }

    #[test]
    fn mp4_on_a_ring_is_refused() {
        isolated(super::mp4_on_a_ring_is_refused);
    }

    #[test]
    fn an_m4a_with_cover_art_plays_from_either_end() {
        isolated(super::an_m4a_with_cover_art_plays_from_either_end);
    }
}
