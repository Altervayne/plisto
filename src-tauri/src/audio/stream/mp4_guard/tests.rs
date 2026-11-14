use super::*;
use crate::audio::stream::test_containers::*;
use std::io::Cursor;

fn check(file: &[u8]) -> Result<(), Refused> {
    check_mp4(&mut Cursor::new(file), file.len() as u64)
}

fn keep(_: &[u8; 4], p: Vec<u8>) -> Vec<u8> {
    p
}

// The payload of a counted table with `count` and no entries.
fn table(count: u32, header: &[u8]) -> Vec<u8> {
    let mut v = vec![0u8; 4];
    v.extend_from_slice(header);
    v.extend_from_slice(&count.to_be_bytes());
    v
}

#[test]
fn well_formed_files_pass() {
    for spec in [
        M4a::default(),
        M4a {
            moov_last: true,
            cover: 3_000,
            co64: true,
            edit_list: true,
            ..M4a::default()
        },
        M4a {
            alac_frame: Some(4_096),
            ..M4a::default()
        },
    ] {
        assert_eq!(check(&m4a(&spec, &keep)), Ok(()));
    }
}

#[test]
fn every_counted_table_is_checked_against_its_bytes() {
    let cases: [(&[u8; 4], Vec<u8>, M4a); 6] = [
        (b"stsz", table(0xFFFF_FFFF, &[0; 4]), M4a::default()),
        (b"stco", table(0xFFFF_FFFF, &[]), M4a::default()),
        (b"stts", table(0x4000_0000, &[]), M4a::default()),
        (b"stsc", table(0x4000_0000, &[]), M4a::default()),
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
        assert_eq!(
            check(&file),
            Err(Refused),
            "{}",
            String::from_utf8_lossy(kind)
        );
    }
    // A table count within the bytes but past the entry cap.
    let mut stsz = table(MP4_ENTRIES_MAX + 1, &[0; 4]);
    stsz.extend(vec![0u8; (MP4_ENTRIES_MAX as usize + 1) * 4]);
    let file = m4a(&M4a::default(), &|k, p| {
        if k == b"stsz" {
            stsz.clone()
        } else {
            p
        }
    });
    assert_eq!(check(&file), Err(Refused));
}

#[test]
fn boxes_read_whole_are_capped() {
    // A handler too short for its fixed fields, an oversized sample, an ALAC frame length, a
    // cover past the item cap, and an esds descriptor claiming 256 MiB.
    let short_hdlr = m4a(&M4a::default(), &|k, p| {
        if k == b"hdlr" {
            vec![0; 8]
        } else {
            p
        }
    });
    assert_eq!(check(&short_hdlr), Err(Refused));

    let mut big_sample = table(1, &[0; 4]);
    big_sample.extend_from_slice(&(MP4_SAMPLE_MAX + 1).to_be_bytes());
    let file = m4a(&M4a::default(), &|k, p| {
        if k == b"stsz" {
            big_sample.clone()
        } else {
            p
        }
    });
    assert_eq!(check(&file), Err(Refused));

    let alac = M4a {
        alac_frame: Some(0xFFFF_FFFF),
        ..M4a::default()
    };
    assert_eq!(check(&m4a(&alac, &keep)), Err(Refused));

    let cover = M4a {
        cover: MP4_ITEM_MAX as usize,
        ..M4a::default()
    };
    assert_eq!(check(&m4a(&cover, &keep)), Err(Refused));

    // An ES descriptor claiming 256 MiB is only a scope: symphonia stops at the first read past
    // the box and allocates nothing from it.
    let esds = vec![0, 0, 0, 0, 0x03, 0x8F, 0xFF, 0xFF, 0x7F, 0, 1, 0];
    let file = m4a(&M4a::default(), &|k, p| {
        if k == b"esds" {
            esds.clone()
        } else {
            p
        }
    });
    assert_eq!(check(&file), Ok(()));
    let mut inner = vec![0, 0, 0, 0, 0x03, 30, 0, 1, 0, 0x04, 25];
    inner.extend_from_slice(&[0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    inner.extend_from_slice(&[0x05, 0x8F, 0xFF, 0xFF, 0x7F, 0x12, 0x08]);
    let file = m4a(&M4a::default(), &|k, p| {
        if k == b"esds" {
            inner.clone()
        } else {
            p
        }
    });
    assert_eq!(check(&file), Err(Refused));
}

#[test]
fn atom_sizes_that_cannot_be_valid_are_refused() {
    let good = m4a(&M4a::default(), &keep);

    // A child that runs past its parent.
    let mut past = good.clone();
    grow_atom(&mut past, b"hdlr", 1_000);
    assert_eq!(check(&past), Err(Refused));

    // A size-0 atom that is not mdat, and a 64-bit size smaller than its header.
    let mut zero = good.clone();
    zero.extend_from_slice(b"\x00\x00\x00\x00free");
    assert_eq!(check(&zero), Err(Refused));
    let mut large = good.clone();
    large.extend_from_slice(b"\x00\x00\x00\x01free\x00\x00\x00\x00\x00\x00\x00\x08");
    assert_eq!(check(&large), Err(Refused));
    // A size-0 mdat running to the end is fine.
    let mut open = m4a(&M4a::default(), &keep);
    let at = open.windows(4).rposition(|w| w == b"mdat").unwrap() - 4;
    open[at..at + 4].copy_from_slice(&[0; 4]);
    assert_eq!(check(&open), Ok(()));

    // Fragmented files are refused.
    let mut frag = good;
    frag.extend(atom(b"moof", &[]));
    assert_eq!(check(&frag), Err(Refused));
}
