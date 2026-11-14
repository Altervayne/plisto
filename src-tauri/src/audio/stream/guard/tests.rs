use super::*;
use crate::audio::stream::test_containers::{comment_with, picture_comment};

// Feeds `bytes` whole and in every pair of pieces; every feeding must agree with `whole`.
fn check(bytes: &[u8]) -> Result<(), Refused> {
    let mut guard = HeaderGuard::new();
    let whole = guard.feed(0, bytes);
    for split in 0..=bytes.len() {
        let mut guard = HeaderGuard::new();
        let res = guard
            .feed(0, &bytes[..split])
            .and_then(|_| guard.feed(split as u64, &bytes[split..]));
        assert_eq!(res, whole, "split at {split}");
    }
    whole
}

fn chunk(tag: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = tag.to_vec();
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(body);
    if body.len() % 2 == 1 {
        v.push(0);
    }
    v
}

fn wav(chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut v = b"RIFF\xFF\xFF\xFF\xFFWAVE".to_vec();
    for c in chunks {
        v.extend_from_slice(c);
    }
    v
}

fn fmt(block_align: u16) -> Vec<u8> {
    let mut body = vec![1, 0, 1, 0];
    body.extend_from_slice(&44_100u32.to_le_bytes());
    body.extend_from_slice(&88_200u32.to_le_bytes());
    body.extend_from_slice(&block_align.to_le_bytes());
    body.extend_from_slice(&16u16.to_le_bytes());
    chunk(b"fmt ", &body)
}

#[test]
fn wav_sizes_are_checked() {
    let info = |len: u32| {
        let mut v = b"LIST".to_vec();
        v.extend_from_slice(&len.to_le_bytes());
        v.extend_from_slice(b"INFO");
        v
    };
    let data = chunk(b"data", &[0; 8]);
    // A sane header passes, odd-length chunks and unknown chunks included.
    assert_eq!(
        check(&wav(&[fmt(2), chunk(b"junk", &[1, 2, 3]), data.clone()])),
        Ok(())
    );
    let mut ok_info = info(12);
    ok_info.extend_from_slice(&chunk(b"INAM", b"Song"));
    assert_eq!(check(&wav(&[fmt(2), ok_info, data.clone()])), Ok(()));
    // A huge INFO list, and a block alignment that sizes huge packets.
    assert_eq!(check(&wav(&[fmt(2), info(0x7FFF_FFF0)])), Err(Refused));
    assert_eq!(check(&wav(&[fmt(65_535)])), Err(Refused));
    // A huge chunk that is not parsed is skipped, not refused.
    let mut skipped = b"junk".to_vec();
    skipped.extend_from_slice(&0x7FFF_FFF0u32.to_le_bytes());
    assert_eq!(check(&wav(&[fmt(2), skipped])), Ok(()));
}

fn block(kind: u8, last: bool, body: &[u8]) -> Vec<u8> {
    let len = body.len() as u32;
    let mut v = vec![kind | if last { 0x80 } else { 0 }];
    v.extend_from_slice(&len.to_be_bytes()[1..]);
    v.extend_from_slice(body);
    v
}

fn flac(blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut v = b"fLaC".to_vec();
    v.extend(block(0, false, &[0; 34]));
    for b in blocks {
        v.extend_from_slice(b);
    }
    v
}

fn comment(vendor_len: u32, lens: &[u32]) -> Vec<u8> {
    let mut v = vendor_len.to_le_bytes().to_vec();
    v.extend(std::iter::repeat_n(b'v', vendor_len.min(64) as usize));
    v.extend_from_slice(&(lens.len() as u32).to_le_bytes());
    for &n in lens {
        v.extend_from_slice(&n.to_le_bytes());
        v.extend(std::iter::repeat_n(b'c', n.min(64) as usize));
    }
    v
}

fn picture(mime: u32, desc: u32, data: u32) -> Vec<u8> {
    let mut v = 3u32.to_be_bytes().to_vec();
    v.extend_from_slice(&mime.to_be_bytes());
    v.extend(std::iter::repeat_n(b'm', mime.min(64) as usize));
    v.extend_from_slice(&desc.to_be_bytes());
    v.extend(std::iter::repeat_n(b'd', desc.min(64) as usize));
    v.extend_from_slice(&[0; 16]);
    v.extend_from_slice(&data.to_be_bytes());
    v.extend(std::iter::repeat_n(0u8, data.min(64) as usize));
    v
}

#[test]
fn flac_sizes_are_checked() {
    let ok = flac(&[
        block(4, false, &comment(5, &[7, 0, 3])),
        block(6, false, &picture(9, 2, 40)),
        block(1, true, &[0; 10]),
    ]);
    assert_eq!(check(&ok), Ok(()));
    assert_eq!(check(&flac(&[block(4, true, &comment(5, &[]))])), Ok(()));
    let cover = comment_with(&[&picture_comment(9, 500)]);
    assert_eq!(check(&flac(&[block(4, true, &cover)])), Ok(()));

    let hostile = [
        block(4, true, &comment(0xFFFF_FFF0, &[])),
        block(4, true, &comment(4, &[0x4000_0000])),
        // A picture inside a `METADATA_BLOCK_PICTURE` comment.
        block(4, true, &comment_with(&[&picture_comment(0x1000_0000, 0)])),
        block(6, true, &picture(0xFFFF_FFF0, 0, 0)),
        block(6, true, &picture(4, 0xFFFF_FFF0, 0)),
        block(6, true, &picture(4, 2, 0xFFFF_FFF0)),
        // A seek table header claiming more than the cap; its body never needs to arrive.
        {
            let mut v = vec![0x83];
            v.extend_from_slice(&(FLAC_SEEKTABLE_MAX + 18).to_be_bytes()[1..]);
            v
        },
    ];
    for (i, b) in hostile.iter().enumerate() {
        assert_eq!(
            check(&flac(std::slice::from_ref(b))),
            Err(Refused),
            "case {i}"
        );
    }
}

#[test]
fn other_containers_pass_and_skipped_fields_are_refused() {
    assert_eq!(check(b"OggS\x00\x02 the rest of a page"), Ok(()));
    assert_eq!(check(b"\xFF\xFB\x90\xC0 mp3 frames follow"), Ok(()));

    // A read that starts past a field the guard has not seen.
    let bytes = wav(&[fmt(2)]);
    let mut guard = HeaderGuard::new();
    guard.feed(0, &bytes[..12]).unwrap();
    assert_eq!(guard.feed(30, &bytes[30..]), Err(Refused));
    // A seek back before the field restarts it; one past it is refused.
    let mut guard = HeaderGuard::new();
    guard.feed(0, &bytes[..14]).unwrap();
    assert_eq!(guard.seeked(12), Ok(()));
    assert_eq!(guard.feed(12, &bytes[12..]), Ok(()));
    let mut guard = HeaderGuard::new();
    guard.feed(0, &bytes[..12]).unwrap();
    assert_eq!(guard.seeked(40), Err(Refused));
}
