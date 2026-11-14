use super::*;
use std::io::Cursor;

// An ID3v2.3 tag of `body` bytes, with the footer flag when `footer`.
fn tag(body: usize, footer: bool) -> Vec<u8> {
    let mut v = b"ID3\x03\x00".to_vec();
    v.push(if footer { 0x10 } else { 0 });
    let n = body as u32;
    v.extend_from_slice(&[
        ((n >> 21) & 0x7F) as u8,
        ((n >> 14) & 0x7F) as u8,
        ((n >> 7) & 0x7F) as u8,
        (n & 0x7F) as u8,
    ]);
    v.extend(std::iter::repeat_n(0xAB, body));
    if footer {
        v.extend_from_slice(b"3DI\x03\x00\x10\x00\x00\x00\x00");
    }
    v
}

const AUDIO: &[u8] = b"\xFF\xFB\x90\xC0 then the audio itself";

#[test]
fn leading_tags_are_skipped_on_both_kinds_of_source() {
    let mut bytes = tag(300, false);
    bytes.extend(tag(20, true));
    bytes.extend_from_slice(AUDIO);
    let base = (10 + 300 + 10 + 20 + 10) as u64;

    // Unseekable: the bytes read past the tags come back as the head.
    let mut src = Cursor::new(bytes.clone());
    let (at, head) = skip_id3(&mut src, false).unwrap();
    assert_eq!(at, base);
    assert_eq!(head, &AUDIO[..10]);
    let mut rest = Vec::new();
    let mut trimmed = Trimmed::new(src, at, head);
    trimmed.read_to_end(&mut rest).unwrap();
    assert_eq!(rest, AUDIO);

    // Seekable: the source stands on the audio and seeks are relative to it.
    let mut src = Cursor::new(bytes);
    let (at, head) = skip_id3(&mut src, true).unwrap();
    assert_eq!((at, head.len()), (base, 0));
    let mut trimmed = Trimmed::new(src, at, head);
    assert_eq!(trimmed.seek(SeekFrom::Start(4)).unwrap(), 4);
    let mut four = [0u8; 4];
    trimmed.read_exact(&mut four).unwrap();
    assert_eq!(&four, b" the");
}

#[test]
fn no_tag_leaves_the_bytes_alone() {
    let mut src = Cursor::new(AUDIO.to_vec());
    let (at, head) = skip_id3(&mut src, false).unwrap();
    assert_eq!((at, head.as_slice()), (0, &AUDIO[..10]));
    // A body shorter than a tag header comes back whole.
    let mut src = Cursor::new(b"ID3".to_vec());
    assert_eq!(skip_id3(&mut src, false).unwrap(), (0, b"ID3".to_vec()));
}

#[test]
fn tags_past_the_caps_are_refused() {
    // More tags than allowed, each empty.
    let mut bytes = Vec::new();
    for _ in 0..=ID3_TAGS_MAX {
        bytes.extend(tag(0, false));
    }
    bytes.extend_from_slice(AUDIO);
    let mut src = Cursor::new(bytes);
    assert!(matches!(skip_id3(&mut src, false), Err(SkipError::Refused)));

    // A tag that claims more than the skip cap: refused before a byte of it is read.
    let mut big = tag(0, false);
    big[6..10].copy_from_slice(&[0x7F, 0x7F, 0x7F, 0x7F]);
    let mut src = Cursor::new(big);
    assert!(matches!(skip_id3(&mut src, false), Err(SkipError::Refused)));
    assert_eq!(src.position(), 10);

    // A tag the bytes end inside.
    let mut cut = tag(100, false);
    cut.truncate(50);
    let mut src = Cursor::new(cut);
    assert!(matches!(skip_id3(&mut src, false), Err(SkipError::Refused)));
}
