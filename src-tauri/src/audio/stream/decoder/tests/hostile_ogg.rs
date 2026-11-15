use super::hostile::{measure, ALLOC_BOUND};
use super::*;
use crate::audio::stream::test_containers::*;
use crate::audio::stream::OGG_SERIALS_MAX;

const EVIL: u32 = 0x1000_0000;
const S: u32 = 0x5151;

// Plays `bytes` from a ring or a growing buffer whose writer stays open.
fn play(bytes: &[u8], seekable: bool, hint: &'static str) -> (DecodeEnd, usize) {
    let control = Arc::new(StreamControl::new());
    if seekable {
        let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
        writer.write(bytes).unwrap();
        let measured = measure(body, Some(hint), &control);
        drop(writer);
        measured
    } else {
        let (writer, ring) = byte_ring(bytes.len() + 1, Arc::clone(&control));
        writer.try_write(bytes).unwrap();
        let measured = measure(ring, Some(hint), &control);
        drop(writer);
        measured
    }
}

fn assert_refused(bytes: &[u8], hint: &'static str, what: &str) {
    for seekable in [false, true] {
        let (end, largest) = play(bytes, seekable, hint);
        let what = format!("{what}, seekable {seekable}");
        assert_eq!(end, DecodeEnd::Failed(Unsupported::Format), "{what}");
        assert!(largest < ALLOC_BOUND, "{what}: allocated {largest} bytes");
    }
}

// A Vorbis comment packet: the given comments, then the framing bit.
fn vorbis_comment(comments: &[&[u8]]) -> Vec<u8> {
    let mut v = b"\x03vorbis".to_vec();
    v.extend(comment_with(comments));
    v.push(1);
    v
}

// A comment packet whose one comment claims `EVIL` bytes.
fn evil_comment() -> Vec<u8> {
    let mut v = b"\x03vorbis".to_vec();
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&1u32.to_le_bytes());
    v.extend_from_slice(&EVIL.to_le_bytes());
    v
}

#[test]
fn a_first_page_flag_hides_no_header_packet() {
    // The comment packet sits on a page flagged first, of the same logical stream, in the header
    // phase.
    let mut evil = evil_comment();
    evil.extend_from_slice(&[b'x'; 16]);
    let mut v = ogg_page(S, 0, FIRST, &[&vorbis_ident()], false);
    v.extend(ogg_page(S, 1, 0, &[&vorbis_comment(&[])], false));
    v.extend(ogg_page(S, 2, FIRST, &[&evil], false));
    v.extend(ogg_page(S, 3, 0, &[&[0u8; 10]], false));
    assert_refused(&v, "ogg", "header phase");

    // At a chain restart: a first link plays, then the second link's comment page is flagged
    // first.
    let mut chained = ogg_opus_bytes(0x21, 1, 10, 312);
    chained.extend(ogg_page(S, 0, FIRST, &[&vorbis_ident()], false));
    chained.extend(ogg_page(S, 1, FIRST, &[&evil], false));
    chained.extend(ogg_page(S, 2, 0, &[&[0u8; 10]], false));
    assert_refused(&chained, "ogg", "chain restart");
}

#[test]
fn a_picture_comment_is_refused_in_every_mapping_and_in_native_flac() {
    let hostile = picture_comment(EVIL, 0);
    let mut vorbis = ogg_page(S, 0, FIRST, &[&vorbis_ident()], false);
    vorbis.extend(ogg_page(S, 1, 0, &[&vorbis_comment(&[&hostile])], false));
    vorbis.extend(ogg_page(S, 2, 0, &[&[0u8; 10]], false));
    assert_refused(&vorbis, "ogg", "vorbis");

    let mut tags = b"OpusTags".to_vec();
    tags.extend(comment_with(&[&hostile]));
    let mut opus = ogg_page(S, 0, FIRST, &[&opus_head()], false);
    opus.extend(ogg_page(S, 1, 0, &[&tags], false));
    assert_refused(&opus, "ogg", "opus");

    let block = comment_with(&[&hostile]);
    let mut packet = vec![0x84];
    packet.extend_from_slice(&(block.len() as u32).to_be_bytes()[1..]);
    packet.extend(&block);
    let mut flac = ogg_page(S, 0, FIRST, &[&flac_ogg_ident()], false);
    flac.extend(ogg_page(S, 1, 0, &[&packet], false));
    assert_refused(&flac, "ogg", "flac in ogg");

    // Native FLAC: STREAMINFO, then the comment block as the last metadata block.
    let mut native = flac_bytes(1, 4_096)[..42].to_vec();
    native[4] = 0x00;
    native.extend(&packet);
    native.extend_from_slice(&[0u8; 64]);
    assert_refused(&native, "flac", "native flac");
}

#[test]
fn a_sound_picture_comment_still_plays() {
    // An Ogg Opus stream whose comment header carries a 30 kB cover.
    let opus = ogg_opus_bytes(0x31, 1, 30, 312);
    let head = pages_len(&opus, 1);
    let tags_end = pages_len(&opus, 2);
    let mut tags = b"OpusTags".to_vec();
    tags.extend(comment_with(&[
        b"TITLE=cover test",
        &picture_comment(9, 30_000),
    ]));
    let mut bytes = opus[..head].to_vec();
    bytes.extend(ogg_page(0x31, 1, 0, &[&tags], false));
    bytes.extend_from_slice(&opus[tags_end..]);
    for seekable in [false, true] {
        let control = Arc::new(StreamControl::new());
        let (segments, end) = if seekable {
            let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
            writer.write(&bytes).unwrap();
            writer.finish();
            start(media(body, Some("ogg")), &control).finish()
        } else {
            let (writer, ring) = byte_ring(bytes.len() + 1, Arc::clone(&control));
            writer.try_write(&bytes).unwrap();
            writer.finish();
            start(media(ring, Some("ogg")), &control).finish()
        };
        assert_eq!(end, DecodeEnd::Finished, "seekable {seekable}");
        assert_eq!(
            frames_of(&segments),
            30 * OPUS_FRAME - 312,
            "seekable {seekable}"
        );
    }
}

// A Vorbis stream whose comment is cut at a page boundary, its continuation page, `middle`
// pages of a lone partial packet, then 100 kB of another stream: symphonia's stream-end search
// bisects over it, seeking several times before it reads the continuation.
fn bisected(middle: usize) -> Vec<u8> {
    let mut f = ogg_page(S, 0, FIRST, &[&vorbis_ident()], false);
    f.extend(ogg_page(S, 1, 0, &[&vorbis_comment(&[])], false));
    let mut cut = evil_comment();
    cut.resize(255, b'x');
    f.extend(ogg_page(S, 2, 0, &[&[0u8; 10], &cut], true));
    let filler = vec![0u8; 254];
    let tail = [b'x'; 10];
    let mut packets: Vec<&[u8]> = vec![&tail];
    for _ in 0..200 {
        packets.push(&filler);
    }
    f.extend(ogg_page(S, 3, CONTINUED, &packets, false));
    let part = vec![0u8; 255];
    for i in 0..middle {
        f.extend(ogg_page(S, 1_000 + i as u32, 0, &[&part], true));
    }
    let other = vec![0u8; 200];
    let start = f.len();
    let mut i = 0;
    while f.len() - start < 100_000 {
        f.extend(ogg_page(0x7777, i, 0, &[&other], false));
        i += 1;
    }
    f
}

// Opens symphonia's Ogg reader behind the guard on a watched thread and pulls packets until an
// error, at most 10,000. These streams carry no setup header, so the decode thread would
// stop at the decoder before pulling; the reader is driven directly instead. Returns whether the
// guard refused and the largest single allocation.
fn pull_through_guard(bytes: Vec<u8>, seekable: bool) -> (bool, usize) {
    use crate::audio::stream::guard::Guarded;
    use std::sync::atomic::AtomicBool;
    use symphonia::core::formats::{FormatOptions, FormatReader};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::default::formats::OggReader;

    fn pull<S: MediaSource + 'static>(
        source: S,
        flag: Arc<AtomicBool>,
        record: &'static std::sync::atomic::AtomicUsize,
    ) {
        // Watched from here: the test's own buffer of the body is not the reader's allocation.
        crate::audio::stream::isolate::alloc::watch_this_thread(record);
        let mss = MediaSourceStream::new(Box::new(Guarded::new(source, flag)), Default::default());
        if let Ok(mut reader) = OggReader::try_new(mss, &FormatOptions::default()) {
            for _ in 0..10_000 {
                if reader.next_packet().is_err() {
                    break;
                }
            }
        }
    }

    let record = crate::audio::stream::isolate::alloc::new_record();
    let refused = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&refused);
    std::thread::spawn(move || {
        let control = Arc::new(StreamControl::new());
        if seekable {
            let (writer, body) = growing_buffer(bytes.len() as u64, control);
            writer.write(&bytes).unwrap();
            writer.finish();
            pull(body, flag, record);
        } else {
            let (writer, ring) = byte_ring(bytes.len() + 1, control);
            writer.try_write(&bytes).unwrap();
            writer.finish();
            pull(ring, flag, record);
        }
    })
    .join()
    .unwrap();
    (
        refused.load(std::sync::atomic::Ordering::Acquire),
        record.load(std::sync::atomic::Ordering::Relaxed),
    )
}

#[test]
fn a_comment_cut_across_the_stream_end_search_is_refused() {
    // Under and over the size where symphonia's stream-end search starts bisecting.
    for middle in [0, 7_500] {
        for seekable in [false, true] {
            let (refused, largest) = pull_through_guard(bisected(middle), seekable);
            let what = format!("middle {middle}, seekable {seekable}");
            assert!(refused, "{what}: the guard let it through");
            assert!(largest < ALLOC_BOUND, "{what}: allocated {largest} bytes");
        }
    }
}

// An MP4 whose esds payload is `esds`.
fn mp4_with_esds(esds: Vec<u8>) -> Vec<u8> {
    m4a(&M4a::default(), &|k, p| {
        if k == b"esds" {
            esds.clone()
        } else {
            p
        }
    })
}

fn assert_mp4_refused(bytes: &[u8], what: &str) {
    let control = Arc::new(StreamControl::new());
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(bytes).unwrap();
    let (end, largest) = measure(body, Some("m4a"), &control);
    drop(writer);
    assert_eq!(end, DecodeEnd::Failed(Unsupported::Format), "{what}");
    assert!(largest < ALLOC_BOUND, "{what}: allocated {largest} bytes");
}

#[test]
fn esds_descriptors_are_walked_as_symphonia_walks_them() {
    // symphonia reads one byte of an SL descriptor and parses the rest of its body as descriptors:
    // a decoder config hidden there carries a 256 MiB decoder-specific info.
    let mut config = vec![0x04, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    config.extend_from_slice(&[0x05, 2, 0x12, 0x10]);
    let mut sl = vec![0x06, 21, 0x02];
    sl.extend_from_slice(&[0x04, 18, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    sl.extend_from_slice(&[0x05, 0xFF, 0xFF, 0xFF, 0x7F]);
    let mut es = vec![0x03, (3 + config.len() + sl.len()) as u8, 0, 1, 0];
    es.extend(config);
    es.extend(sl);
    let mut esds = vec![0u8; 4];
    esds.extend(es);
    assert_mp4_refused(&mp4_with_esds(esds), "sl drift");

    // An ES descriptor with an optional field: its children start after it, past where its
    // declared length would put them.
    let mut children = vec![0x04, 18, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    children.extend_from_slice(&[0x05, 0xFF, 0xFF, 0xFF, 0x7F]);
    children.extend_from_slice(&[0x06, 1, 2]);
    let mut es = vec![0x03, (3 + children.len()) as u8, 0, 1, 0x80, 0, 0];
    es.extend(children);
    let mut esds = vec![0u8; 4];
    esds.extend(es);
    assert_mp4_refused(&mp4_with_esds(esds), "optional field drift");
}

// `count` first pages of other streams, in runs of eight between pages of yet another stream,
// so no run of first pages passes `OGG_STREAMS_MAX`.
fn foreign_first_pages(f: &mut Vec<u8>, count: u32) {
    let mut n = 0u32;
    while n < count {
        for _ in 0..8 {
            if n == count {
                break;
            }
            f.extend(ogg_page(0xA000 + n, 0, FIRST, &[&[0u8]], false));
            n += 1;
        }
        f.extend(ogg_page(0xBEEF, n, 0, &[&[0u8]], false));
    }
}

// The real stream's comment arrives after `foreign` first pages of other streams, which
// symphonia's header loop skips.
fn foreign_in_header_loop(foreign: u32, evil: bool) -> Vec<u8> {
    let mut f = ogg_page(S, 0, FIRST, &[&vorbis_ident()], false);
    f.extend(ogg_page(S, 1, 0, &[&vorbis_comment(&[])], false));
    foreign_first_pages(&mut f, foreign);
    let mut comment = if evil {
        evil_comment()
    } else {
        vorbis_comment(&[])
    };
    comment.extend_from_slice(&[b'x'; 16]);
    f.extend(ogg_page(S, 2, 0, &[&comment], false));
    f.extend(ogg_page(S, 3, 0, &[&[0u8; 10]], false));
    f
}

// The real stream plays 250 kB, then `foreign` first pages of other streams follow at the end,
// where symphonia's stream-end search reads them; the comment sits in the middle.
fn foreign_at_the_end(foreign: u32, evil: bool) -> Vec<u8> {
    let mut f = ogg_page(S, 0, FIRST, &[&vorbis_ident()], false);
    f.extend(ogg_page(S, 1, 0, &[&vorbis_comment(&[])], false));
    let mut seq = 2;
    let audio = vec![0u8; 200];
    let fill = |f: &mut Vec<u8>, seq: &mut u32, bytes: usize| {
        let start = f.len();
        while f.len() - start < bytes {
            f.extend(ogg_page(S, *seq, 0, &[&audio], false));
            *seq += 1;
        }
    };
    fill(&mut f, &mut seq, 100_000);
    if evil {
        let mut comment = evil_comment();
        comment.extend_from_slice(&[b'x'; 16]);
        f.extend(ogg_page(S, seq, 0, &[&comment], false));
        seq += 1;
    }
    fill(&mut f, &mut seq, 150_000);
    foreign_first_pages(&mut f, foreign);
    f.extend(vec![0u8; 10_000]);
    f
}

#[test]
fn foreign_streams_never_make_the_guard_forget_the_real_one() {
    let limit = OGG_SERIALS_MAX as u32 - 1;
    for seekable in [false, true] {
        for (name, build) in [
            (
                "header loop",
                foreign_in_header_loop as fn(u32, bool) -> Vec<u8>,
            ),
            ("stream end", foreign_at_the_end),
        ] {
            let what = format!("{name}, seekable {seekable}");
            // Up to the cap, the real stream is still checked, and a clean one passes.
            let (refused, largest) = pull_through_guard(build(limit, true), seekable);
            assert!(refused, "{what}: the forged comment passed");
            assert!(largest < ALLOC_BOUND, "{what}: allocated {largest} bytes");
            let (refused, _) = pull_through_guard(build(limit, false), seekable);
            assert!(!refused, "{what}: a clean stream was refused");
            // One stream past the cap is refused, whatever follows.
            let (refused, largest) = pull_through_guard(build(limit + 1, false), seekable);
            assert!(refused, "{what}: the stream past the cap was accepted");
            assert!(largest < ALLOC_BOUND, "{what}: allocated {largest} bytes");
        }
    }
}

// A comment cut at the page that ends the opening, carried on by a small continuation page inside
// the first read-ahead, and completed by a page past it. symphonia's stream-end search seeks back
// to the end of the cut page, a boundary the chain no longer records once it has moved on.
fn chain_moved_on() -> Vec<u8> {
    let mut f = ogg_page(S, 0, FIRST, &[&vorbis_ident()], false);
    f.extend(ogg_page(S, 1, 0, &[&vorbis_comment(&[])], false));
    let mut cut = evil_comment();
    cut.resize(255, b'x');
    f.extend(ogg_page(S, 2, 0, &[&[0u8; 10], &cut], true));
    f.extend(ogg_page(S, 3, CONTINUED, &[&[b'x'; 255]], true));
    let tail = [b'x'; 10];
    let filler = vec![0u8; 254];
    let mut packets: Vec<&[u8]> = vec![&tail];
    for _ in 0..200 {
        packets.push(&filler);
    }
    f.extend(ogg_page(S, 4, CONTINUED, &packets, false));
    let audio = vec![0u8; 200];
    let start = f.len();
    let mut seq = 5;
    while f.len() - start < 100_000 {
        f.extend(ogg_page(S, seq, 0, &[&audio], false));
        seq += 1;
    }
    f
}

#[test]
#[ignore = "known gap of the first-layer Ogg guard: a chain moved on past the boundary a seek \
            returns to; decode isolation covers it"]
fn a_chain_moved_on_past_a_seek_back_boundary_is_missed() {
    for seekable in [false, true] {
        let (refused, largest) = pull_through_guard(chain_moved_on(), seekable);
        assert!(refused, "seekable {seekable}: the forged comment passed");
        assert!(
            largest < ALLOC_BOUND,
            "seekable {seekable}: allocated {largest} bytes"
        );
    }
}

// The refusals above that run a decode thread, with the decoding in a decode helper. The tests
// that drive the guard reader alone have no decode thread to move.
mod isolated {
    use super::super::isolated;

    #[test]
    fn a_first_page_flag_hides_no_header_packet() {
        isolated(super::a_first_page_flag_hides_no_header_packet);
    }

    #[test]
    fn a_picture_comment_is_refused_in_every_mapping_and_in_native_flac() {
        isolated(super::a_picture_comment_is_refused_in_every_mapping_and_in_native_flac);
    }

    #[test]
    fn a_sound_picture_comment_still_plays() {
        isolated(super::a_sound_picture_comment_still_plays);
    }

    #[test]
    fn esds_descriptors_are_walked_as_symphonia_walks_them() {
        isolated(super::esds_descriptors_are_walked_as_symphonia_walks_them);
    }
}
