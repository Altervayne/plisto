use super::*;

fn thumb(width: u32, height: u32) -> Thumb {
    Thumb {
        width,
        height,
        rgb: (0..width * height * 3).map(|i| i as u8).collect(),
    }
}

fn tags() -> Inspected {
    Inspected::Read(InspectedFile {
        title: Some("Title".into()),
        artist: None,
        track_gain: Some("-6.52 dB".into()),
        track_peak: Some("0.98".into()),
        duration_secs: Some(201.5),
        has_picture: true,
    })
}

fn cover(thumbs: [Thumb; 2]) -> Option<InspectedCover> {
    Some(InspectedCover {
        width: 3000,
        height: 2000,
        thumbs,
    })
}

fn covered(cover: Option<InspectedCover>) -> HelperFrame {
    HelperFrame::Covered(cover)
}

// An `Inspected` payload with one title text of `len` bytes, the given bytes, and nothing else.
fn text_payload(len: u16, bytes: &[u8]) -> Vec<u8> {
    let mut payload = vec![1, 1];
    payload.extend(len.to_le_bytes());
    payload.extend(bytes);
    payload.extend([0, 0, 0, 0, 0]);
    payload
}

fn round_trip(frame: HelperFrame) -> HelperFrame {
    let mut r = HelperReader::new(Cursor::new(frame.encode().unwrap()));
    r.read_frame().unwrap().unwrap()
}

#[test]
fn inspect_cover_and_their_answers_round_trip() {
    for ask in [
        MainFrame::Inspect(Inspect {
            hint: Some("m4a".into()),
            len: 1 << 40,
        }),
        MainFrame::Cover(Cover {
            image_len: Some(12_345),
            edges: [128, 512],
        }),
        MainFrame::Cover(Cover {
            image_len: None,
            edges: [1, 1],
        }),
    ] {
        let mut r = MainReader::new(Cursor::new(ask.encode().unwrap()));
        assert_eq!(r.read_frame(), Ok(Some(ask)));
    }

    for answer in [Inspected::Unreadable, tags()] {
        let HelperFrame::Inspected(read) = round_trip(HelperFrame::Inspected(answer.clone()))
        else {
            panic!("the tags read back");
        };
        assert_eq!(read, answer);
    }
    for answer in [
        None,
        cover([thumb(128, 85), thumb(1, 512)]),
        cover([thumb(128, 128), thumb(512, 512)]),
    ] {
        let HelperFrame::Covered(read) = round_trip(covered(answer.clone())) else {
            panic!("the cover reads back");
        };
        assert_eq!(read, answer);
    }
}

#[test]
fn edges_out_of_bounds_or_too_large_together_are_refused() {
    assert_eq!(check_edges([128, 512]), Ok([128, 512]));
    assert_eq!(check_edges([0, 512]), Err(WireError::BadEdge(0)));
    assert_eq!(check_edges([128, 513]), Err(WireError::BadEdge(513)));
    // Two full-size thumbnails would not fit one answer.
    assert_eq!(check_edges([512, 512]), Err(WireError::BadEdge(512)));

    let ask = |edges| {
        MainFrame::Cover(Cover {
            image_len: None,
            edges,
        })
    };
    assert_eq!(ask([512, 512]).encode(), Err(WireError::BadEdge(512)));
    let mut bytes = ask([128, 512]).encode().unwrap();
    let at = bytes.len() - 4;
    bytes[at..].copy_from_slice(&600u32.to_le_bytes());
    assert_eq!(main_err(bytes).0, WireError::BadEdge(600));
}

#[test]
fn an_oversized_or_non_utf8_text_is_refused_before_its_bytes() {
    let too_long = (TEXT_MAX + 1) as u16;
    let (err, taken) = helper_err(raw(INSPECTED, &text_payload(too_long, &[])));
    assert_eq!(err, WireError::TextTooLong(TEXT_MAX + 1));
    assert_eq!(taken, HEADER + 4, "nothing past the length is read");
    let (err, _) = helper_err(raw(INSPECTED, &text_payload(2, &[0xC3, 0x28])));
    assert_eq!(err, WireError::TextNotUtf8);

    let Inspected::Read(mut file) = tags() else {
        unreachable!()
    };
    file.title = Some("x".repeat(TEXT_MAX + 1));
    assert_eq!(
        HelperFrame::Inspected(Inspected::Read(file)).encode(),
        Err(WireError::TextTooLong(TEXT_MAX + 1))
    );
}

#[test]
fn image_sizes_out_of_bounds_are_refused_before_the_pixels() {
    // A cover of the given source size and one thumbnail head.
    let payload = |source: (u32, u32), thumb: (u32, u32)| {
        let mut payload = vec![1];
        for value in [source.0, source.1, thumb.0, thumb.1] {
            payload.extend(value.to_le_bytes());
        }
        payload
    };
    for (source, thumb, refused) in [
        ((0, 10), (1, 1), (0, 10)),
        ((SOURCE_EDGE_MAX + 1, 10), (1, 1), (SOURCE_EDGE_MAX + 1, 10)),
        ((10, 10), (EDGE_MAX + 1, 1), (EDGE_MAX + 1, 1)),
        ((10, 10), (4, 0), (4, 0)),
    ] {
        let bytes = raw(COVERED, &payload(source, thumb));
        let (err, taken) = helper_err(bytes.clone());
        assert_eq!(
            err,
            WireError::BadImageSize {
                width: refused.0,
                height: refused.1
            }
        );
        assert!(taken <= bytes.len());
    }
    // A thumbnail whose pixels stop short of its size is refused at the pixels, never padded.
    let mut short = payload((10, 10), (4, 4));
    short.extend([0u8; 4 * 4 * 3 - 1]);
    assert_eq!(helper_err(raw(COVERED, &short)).0, WireError::Short);

    let mut wrong = thumb(4, 4);
    wrong.rgb.pop();
    assert_eq!(
        covered(cover([wrong, thumb(4, 4)])).encode(),
        Err(WireError::BadImageSize {
            width: 4,
            height: 4
        })
    );
}

#[test]
fn tags_answers_have_a_bounded_length_and_known_tags() {
    // The longest legal tags answer is far below the frame cap, and one byte past it is refused
    // from the header.
    let max = *super::super::inspect::INSPECTED_LEN.end();
    assert!(matches!(
        helper_err(header(INSPECTED, max + 1)).0,
        WireError::BadLength { .. }
    ));
    assert!(matches!(
        helper_err(raw(INSPECTED, &[2])).0,
        WireError::BadTag { tag: 2, .. }
    ));
    assert_eq!(
        helper_err(raw(INSPECTED, &[0, 0])).0,
        WireError::Trailing(1)
    );
    let mut picture = text_payload(0, &[]);
    *picture.last_mut().unwrap() = 2;
    assert!(matches!(
        helper_err(raw(INSPECTED, &picture)).0,
        WireError::BadTag { tag: 2, .. }
    ));
}
