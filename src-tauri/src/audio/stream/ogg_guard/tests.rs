use super::*;
use crate::audio::stream::test_containers::*;

// Feeds `bytes` to a fresh guard in `step`-byte reads.
fn feed(bytes: &[u8], step: usize) -> Result<(), Refused> {
    let mut guard = OggGuard::new();
    for (i, piece) in bytes.chunks(step).enumerate() {
        guard.feed((i * step) as u64, piece)?;
    }
    Ok(())
}

fn comment_packet(prefix: &[u8], lens: &[u32]) -> Vec<u8> {
    let mut v = prefix.to_vec();
    v.extend(comment_body(lens));
    v
}

// A stream of `serial`: its first page, then a page holding `second`.
fn two_pages(ident: &[u8], second: &[u8]) -> Vec<u8> {
    let mut v = ogg_page(7, 0, FIRST, &[ident], false);
    v.extend(ogg_page(7, 1, 0, &[second], false));
    v
}

#[test]
fn sane_comment_headers_pass_in_every_mapping_at_every_read_size() {
    let streams = [
        two_pages(&vorbis_ident(), &comment_packet(b"\x03vorbis", &[3, 0, 8])),
        two_pages(&opus_head(), &comment_packet(b"OpusTags", &[5])),
        two_pages(
            &flac_ogg_ident(),
            &comment_packet(&[0x84, 0, 0, 0x20], &[2]),
        ),
    ];
    for bytes in &streams {
        for step in [1, 3, 7, 64, 4_096] {
            assert_eq!(feed(bytes, step), Ok(()), "step {step}");
        }
    }
}

#[test]
fn a_comment_length_past_its_packet_is_refused_in_every_mapping() {
    let streams = [
        two_pages(
            &vorbis_ident(),
            &comment_packet(b"\x03vorbis", &[0xFFFF_FFF0]),
        ),
        two_pages(&opus_head(), &comment_packet(b"OpusTags", &[0xFFFF_FFF0])),
        two_pages(
            &flac_ogg_ident(),
            &comment_packet(&[0x04, 0, 0, 0x20], &[0xFFFF_FFF0]),
        ),
    ];
    for bytes in &streams {
        for step in [1, 5, 4_096] {
            assert_eq!(feed(bytes, step), Err(Refused), "step {step}");
        }
    }
    // A FLAC-in-Ogg picture whose data length runs past the packet.
    let mut picture = vec![0x06, 0, 0, 40];
    picture.extend_from_slice(&3u32.to_be_bytes());
    picture.extend_from_slice(&0xFFFF_FFF0u32.to_be_bytes());
    assert_eq!(
        feed(&two_pages(&flac_ogg_ident(), &picture), 4_096),
        Err(Refused)
    );
    // A comment in a mapping that has none is audio, and passes.
    let null = two_pages(
        b"unknown codec",
        &comment_packet(b"OpusTags", &[0xFFFF_FFF0]),
    );
    assert_eq!(feed(&null, 4_096), Ok(()));
}

#[test]
fn a_comment_spanning_pages_is_checked_whole() {
    let mut packet = comment_packet(b"OpusTags", &[200]);
    packet.resize(510, b'x');
    let (head, tail) = packet.split_at(255);
    let mut ok = ogg_page(9, 0, FIRST, &[&opus_head()], false);
    ok.extend(ogg_page(9, 1, 0, &[head], true));
    ok.extend(ogg_page(9, 2, CONTINUED, &[tail], false));
    assert_eq!(feed(&ok, 100), Ok(()));

    let mut bad = comment_packet(b"OpusTags", &[100_000]);
    bad.resize(510, b'x');
    let (head, tail) = bad.split_at(255);
    let mut v = ogg_page(9, 0, FIRST, &[&opus_head()], false);
    v.extend(ogg_page(9, 1, 0, &[head], true));
    v.extend(ogg_page(9, 2, CONTINUED, &[tail], false));
    assert_eq!(feed(&v, 100), Err(Refused));
}

#[test]
fn a_hostile_page_hidden_in_a_corrupt_page_is_found() {
    // symphonia resumes its search four bytes into a page that fails its CRC, and finds the page
    // embedded in it. So must the guard.
    let mut v = ogg_page(7, 0, FIRST, &[&vorbis_ident()], false);
    let hidden = ogg_page(
        7,
        1,
        0,
        &[&comment_packet(b"\x03vorbis", &[0xFFFF_FFF0])],
        false,
    );
    let mut outer = ogg_page(7, 1, 0, &[&hidden], false);
    outer[22] ^= 0xFF;
    v.extend(outer);
    assert_eq!(feed(&v, 4_096), Err(Refused));
}

#[test]
fn an_endless_header_packet_stops_at_the_cap() {
    let mut guard = OggGuard::new();
    let head = ogg_page(3, 0, FIRST, &[&opus_head()], false);
    guard.feed(0, &head).unwrap();
    let mut pos = head.len() as u64;
    let mut chunk = vec![0u8; 255 * 255];
    chunk[..8].copy_from_slice(b"OpusTags");
    let mut seq = 1;
    let refused = loop {
        let flags = if seq == 1 { 0 } else { CONTINUED };
        let page = ogg_page(3, seq, flags, &[&chunk], true);
        if guard.feed(pos, &page).is_err() {
            break seq;
        }
        pos += page.len() as u64;
        seq += 1;
        assert!(seq < 1_000, "never refused");
    };
    assert_eq!(refused as usize, OGG_PACKET_MAX / chunk.len() + 1);
}

// The smallest valid setup header: one book of two 1-bit codewords.
fn small_setup() -> Vec<u8> {
    vorbis_setup(&[
        (0, 8),
        (0x56_4342, 24),
        (1, 16),
        (2, 24),
        (0, 1),
        (0, 1),
        (0, 5),
        (0, 5),
        (0, 4),
    ])
}

#[test]
fn setup_headers_are_bounded_over_the_stream_and_streams_are_capped() {
    let setup = small_setup();
    let mut v = ogg_page(7, 0, FIRST, &[&vorbis_ident()], false);
    v.extend(ogg_page(
        7,
        1,
        0,
        &[&comment_packet(b"\x03vorbis", &[]), &setup],
        false,
    ));
    // Re-read after seeks, a setup header counts each time, up to the total.
    let mut guard = OggGuard::new();
    guard.feed(0, &v).unwrap();
    let again = ogg_page(7, 1, 0, &[&setup], false);
    let times = VORBIS_SETUP_TOTAL_MAX / setup.len() as u64;
    let mut refused = false;
    for i in 0..times + 2 {
        let at = 1 << (20 + (i % 2));
        guard.seeked(at);
        if guard.feed(at, &again).is_err() {
            refused = true;
            break;
        }
    }
    assert!(refused, "the setup total was never reached");

    let mut many = Vec::new();
    for serial in 0..=OGG_STREAMS_MAX as u32 {
        many.extend(ogg_page(serial, 0, FIRST, &[&opus_head()], false));
    }
    assert_eq!(feed(&many, 4_096), Err(Refused));
}

#[test]
fn a_first_page_flag_never_hides_a_header_packet() {
    // A known stream's page flagged first, mid header phase, still carries its comment to
    // symphonia's mapper.
    let mut evil = comment_packet(b"\x03vorbis", &[0x1000_0000]);
    evil.extend_from_slice(&[b'x'; 16]);
    let mut v = ogg_page(7, 0, FIRST, &[&vorbis_ident()], false);
    v.extend(ogg_page(
        7,
        1,
        0,
        &[&comment_packet(b"\x03vorbis", &[])],
        false,
    ));
    v.extend(ogg_page(7, 2, FIRST, &[&evil], false));
    v.extend(ogg_page(7, 3, 0, &[&[0u8; 10]], false));
    for step in [7, 4_096] {
        assert_eq!(feed(&v, step), Err(Refused), "step {step}");
    }
    // The same at a chain restart, after audio, and with an unknown stream's first page between.
    let mut v = ogg_page(7, 0, FIRST, &[&vorbis_ident()], false);
    v.extend(ogg_page(
        7,
        1,
        0,
        &[&comment_packet(b"\x03vorbis", &[]), &[0u8; 10]],
        false,
    ));
    v.extend(ogg_page(8, 0, FIRST, &[b"other"], false));
    v.extend(ogg_page(7, 2, FIRST, &[&evil], false));
    assert_eq!(feed(&v, 4_096), Err(Refused));
}

#[test]
fn a_picture_comment_is_decoded_and_checked() {
    let hostile = picture_comment(0x1000_0000, 0);
    let fine = picture_comment(9, 300);
    for (prefix, ident) in [
        (&b"\x03vorbis"[..], vorbis_ident()),
        (&b"OpusTags"[..], opus_head()),
        (&[0x84, 0, 0, 0][..], flac_ogg_ident()),
    ] {
        let mut packet = prefix.to_vec();
        packet.extend(comment_with(&[&hostile]));
        assert_eq!(feed(&two_pages(&ident, &packet), 4_096), Err(Refused));
        let mut packet = prefix.to_vec();
        packet.extend(comment_with(&[&fine]));
        assert_eq!(feed(&two_pages(&ident, &packet), 4_096), Ok(()));
    }
}

#[test]
fn many_seeks_never_drop_a_waiting_header_packet() {
    // A comment is cut at a page boundary; the source then seeks away many times, as symphonia's
    // stream-end search does, and returns to the boundary.
    let mut evil = comment_packet(b"\x03vorbis", &[0x1000_0000]);
    evil.resize(255, b'x');
    let mut v = ogg_page(7, 0, FIRST, &[&vorbis_ident()], false);
    v.extend(ogg_page(
        7,
        1,
        0,
        &[&comment_packet(b"\x03vorbis", &[])],
        false,
    ));
    v.extend(ogg_page(7, 2, 0, &[&[0u8; 10], &evil], true));
    let back = v.len() as u64;
    let mut guard = OggGuard::new();
    guard.feed(0, &v).unwrap();
    for i in 0..20u64 {
        let at = (1 << 20) + i * 70_000;
        guard.seeked(at);
        let stray = ogg_page(7, 1_000 + i as u32, CONTINUED, &[], true);
        let _ = guard.feed(at, &stray);
    }
    guard.seeked(back);
    let cont = ogg_page(7, 3, CONTINUED, &[&[b'x'; 10]], false);
    assert_eq!(guard.feed(back, &cont), Err(Refused));
}

// One chain link on a fresh serial: Vorbis (ident, comment and setup, audio) or Opus (head, tags,
// audio).
fn link(serial: u32, vorbis: bool) -> Vec<u8> {
    let audio = [0u8; 40];
    if vorbis {
        let mut v = ogg_page(serial, 0, FIRST, &[&vorbis_ident()], false);
        v.extend(ogg_page(
            serial,
            1,
            0,
            &[&comment_packet(b"\x03vorbis", &[4]), &small_setup()],
            false,
        ));
        v.extend(ogg_page(serial, 2, 0, &[&audio, &audio], false));
        v
    } else {
        let mut v = ogg_page(serial, 0, FIRST, &[&opus_head()], false);
        v.extend(ogg_page(
            serial,
            1,
            0,
            &[&comment_packet(b"OpusTags", &[4])],
            false,
        ));
        v.extend(ogg_page(serial, 2, 0, &[&audio, &audio], false));
        v
    }
}

#[test]
fn a_chained_stream_of_hundreds_of_links_passes_at_a_steady_cost() {
    // 400 links, fed in order as a ring delivers them. Each stream costs one map entry, so the
    // guard's state grows by one entry per link and a page's work does not grow with the count.
    let links: Vec<Vec<u8>> = (0..400u32).map(|i| link(0x1000 + i, i % 2 == 0)).collect();
    let mut guard = OggGuard::new();
    let mut pos = 0u64;
    let mut timings = Vec::new();
    for bytes in &links {
        let started = std::time::Instant::now();
        assert_eq!(guard.feed(pos, bytes), Ok(()));
        timings.push(started.elapsed());
        pos += bytes.len() as u64;
    }
    assert_eq!(guard.state.serials.len(), 400);
    assert!(guard.state.chains.is_empty());
    // A generous bound: the last hundred links cost at most ten times the first hundred.
    let early: std::time::Duration = timings[..100].iter().sum();
    let late: std::time::Duration = timings[300..].iter().sum();
    assert!(
        late <= early * 10 + std::time::Duration::from_millis(50),
        "early {early:?}, late {late:?}"
    );
}

#[test]
fn a_suspended_partial_resumes_on_the_page_that_follows_it() {
    // A comment begins, the source seeks away and back, and its continuation completes it.
    let mut bad = comment_packet(b"OpusTags", &[100_000]);
    bad.resize(510, b'x');
    let (head, tail) = bad.split_at(255);
    let first = ogg_page(9, 0, FIRST, &[&opus_head()], false);
    let open = ogg_page(9, 1, 0, &[head], true);
    let mut guard = OggGuard::new();
    guard.feed(0, &first).unwrap();
    guard.feed(first.len() as u64, &open).unwrap();
    let back = (first.len() + open.len()) as u64;
    guard.seeked(1 << 20);
    guard.seeked(back);
    let cont = ogg_page(9, 2, CONTINUED, &[tail], false);
    assert_eq!(guard.feed(back, &cont), Err(Refused));
}
