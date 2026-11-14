use super::*;
use crate::audio::stream::test_containers::{base64, comment_with, picture_comment};

// Checks `body` fed whole and split at every byte; every split must agree.
fn check(body: &[u8]) -> Result<(), Refused> {
    let mut whole = CommentCheck::new();
    whole.feed(body);
    let verdict = whole.finish();
    for split in 0..=body.len() {
        let mut c = CommentCheck::new();
        c.feed(&body[..split]);
        c.feed(&body[split..]);
        assert_eq!(c.finish(), verdict, "split at {split}");
    }
    verdict
}

fn hostile_picture(key: &str) -> Vec<u8> {
    let mut v = picture_comment(0x1000_0000, 0);
    let at = v.iter().position(|&b| b == b'=').unwrap();
    let mut keyed = key.as_bytes().to_vec();
    keyed.extend_from_slice(&v.split_off(at));
    keyed
}

#[test]
fn comment_lengths_must_fit() {
    assert_eq!(check(&comment_with(&[b"TITLE=x", b"ARTIST=y"])), Ok(()));
    let mut cut = comment_with(&[b"TITLE=a long title"]);
    cut.truncate(cut.len() - 4);
    assert_eq!(check(&cut), Err(Refused));
}

#[test]
fn a_picture_comment_is_checked_under_every_spelling_symphonia_accepts() {
    for key in [
        "METADATA_BLOCK_PICTURE",
        "metadata_block_picture",
        "Metadata_Block_Picture",
        // KELVIN SIGN lower-cases to 'k'.
        "METADATA_BLOC\u{212A}_PICTURE",
    ] {
        assert_eq!(
            check(&comment_with(&[&hostile_picture(key)])),
            Err(Refused),
            "{key}"
        );
    }
    // Keys symphonia does not decode are left alone.
    for key in [
        "METADATA_BLOCK_PICTURES",
        "XMETADATA_BLOCK_PICTURE",
        "COVERART",
    ] {
        assert_eq!(
            check(&comment_with(&[&hostile_picture(key)])),
            Ok(()),
            "{key}"
        );
    }
    // A sound picture passes.
    assert_eq!(check(&comment_with(&[&picture_comment(9, 2_000)])), Ok(()));
}

#[test]
fn an_encoding_symphonia_rejects_is_not_parsed() {
    // A symbol outside the alphabet, an '=' before the end, and a single trailing symbol each make
    // symphonia drop the picture undecoded.
    let base = hostile_picture("METADATA_BLOCK_PICTURE");
    let mut space = base.clone();
    space.insert(30, b' ');
    let mut inner = base.clone();
    inner.insert(30, b'=');
    let mut lone = b"METADATA_BLOCK_PICTURE=".to_vec();
    lone.extend_from_slice(
        base64(&[0, 0, 0, 3, 0x10, 0, 0, 0, 0])
            .trim_end_matches('=')
            .as_bytes(),
    );
    lone.push(b'A');
    for body in [space, inner, lone] {
        assert_eq!(check(&comment_with(&[&body])), Ok(()));
    }
    // Trailing padding is trimmed, so a padded encoding is still decoded and checked.
    assert_eq!(check(&comment_with(&[&base])), Err(Refused));
}
