use super::*;
use crate::audio::stream::{MIN_CHUNK_FRAMES, SPEC_FLIPS_MAX};

/// Hands out 1 to 7 bytes per read, with an `Interrupted` before every read.
struct Choppy {
    inner: Cursor<Vec<u8>>,
    step: usize,
    interrupt: bool,
}

impl Read for Choppy {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.interrupt = !self.interrupt;
        if self.interrupt {
            return Err(io::ErrorKind::Interrupted.into());
        }
        self.step = self.step % 7 + 1;
        let n = buf.len().min(self.step);
        self.inner.read(&mut buf[..n])
    }
}

fn choppy(bytes: Vec<u8>) -> Choppy {
    Choppy {
        inner: Cursor::new(bytes),
        step: 0,
        interrupt: false,
    }
}

fn encoded<T>(frames: &[T], encode: impl Fn(&T) -> Vec<u8>) -> Vec<u8> {
    frames.iter().flat_map(encode).collect()
}

#[test]
fn short_reads_and_interruptions_lose_nothing() {
    let main = main_frames();
    let mut r = MainReader::new(choppy(encoded(&main, |f| f.encode().unwrap())));
    for frame in main {
        assert_eq!(r.read_frame(), Ok(Some(frame)));
    }
    assert_eq!(r.read_frame(), Ok(None));

    let mut helper = helper_frames();
    helper.push(largest_chunk());
    let mut r = HelperReader::new(choppy(encoded(&helper, |f| f.encode().unwrap())));
    for frame in &helper {
        let read = r.read_frame().unwrap().unwrap();
        assert!(same(&read, frame), "{read:?}");
    }
    assert!(matches!(r.read_frame(), Ok(None)));
}

#[test]
fn a_reader_that_failed_refuses_every_later_read() {
    let mut bytes = raw(0x42, &[]);
    bytes.extend(HelperFrame::Ready.encode().unwrap());
    let mut source = counted(bytes);
    let mut r = HelperReader::new(&mut source);
    for _ in 0..3 {
        assert!(matches!(r.read_frame(), Err(WireError::UnknownKind(0x42))));
    }
    // The valid frame after the bad one is never read.
    assert_eq!(source.taken, HEADER);

    let mut bytes = raw(SEEK, &[0; 16]);
    bytes[HEADER..HEADER + 8].copy_from_slice(&f64::NAN.to_le_bytes());
    bytes.extend(MainFrame::Eof.encode().unwrap());
    let mut source = counted(bytes);
    let mut r = MainReader::new(&mut source);
    for _ in 0..3 {
        assert_eq!(r.read_frame(), Err(WireError::BadSeekTarget));
    }
    assert_eq!(source.taken, HEADER + 8);
}

fn spec_chunk(alternate: bool, frames: usize) -> Vec<u8> {
    let rate = if alternate { 44_100 } else { 48_000 };
    chunk(rate, 2, vec![0.0; frames * 2]).encode().unwrap()
}

#[test]
fn a_helper_that_flips_its_spec_on_every_short_chunk_is_refused() {
    // Short runs with a change between each: the flip count reaches the cap and stays legal.
    let mut bytes = Vec::new();
    for i in 0..=SPEC_FLIPS_MAX {
        bytes.extend(spec_chunk(i % 2 == 1, 1));
    }
    let last = SPEC_FLIPS_MAX % 2 == 1;
    // A full run in the same spec resets the count for the next change.
    bytes.extend(spec_chunk(last, MIN_CHUNK_FRAMES));
    for i in 1..=SPEC_FLIPS_MAX + 1 {
        bytes.extend(spec_chunk(last ^ (i % 2 == 1), 1));
    }
    // One more short change is one past the cap.
    bytes.extend(spec_chunk(last ^ (SPEC_FLIPS_MAX % 2 == 1), 1));
    bytes.extend(HelperFrame::Ready.encode().unwrap());

    let mut r = HelperReader::new(Cursor::new(bytes));
    for n in 0..(SPEC_FLIPS_MAX + 1) * 2 + 1 {
        assert!(
            matches!(r.read_frame(), Ok(Some(HelperFrame::Chunk(_)))),
            "chunk {n}"
        );
    }
    assert!(matches!(r.read_frame(), Err(WireError::SpecFlips)));
    assert!(matches!(r.read_frame(), Err(WireError::SpecFlips)));
}

fn break_seam(generation: u64) -> UncheckedSeam {
    let bytes = HelperFrame::Break(UncheckedSeam::new(Seam::Seek(generation)))
        .encode()
        .unwrap();
    match HelperReader::new(Cursor::new(bytes)).read_frame() {
        Ok(Some(HelperFrame::Break(seam))) => seam,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_seek_generation_must_be_requested_and_newer_than_the_last_answered() {
    let control = StreamControl::new();
    control.open_seeks();
    for _ in 0..3 {
        control.request_seek(1.0).unwrap();
    }
    let refused = |got, answered| {
        Err(WireError::BadGeneration {
            got,
            requested: 3,
            answered,
        })
    };
    assert_eq!(break_seam(0).check(&control), refused(0, 0));
    assert_eq!(break_seam(4).check(&control), refused(4, 0));
    assert_eq!(break_seam(2).check(&control), Ok(Seam::Seek(2)));
    control.answer_seek(2);
    // A replayed older or equal generation would move `answered` back or repeat a served seek.
    assert_eq!(break_seam(1).check(&control), refused(1, 2));
    assert_eq!(break_seam(2).check(&control), refused(2, 2));
    assert_eq!(break_seam(3).check(&control), Ok(Seam::Seek(3)));

    let chain = HelperFrame::Break(UncheckedSeam::new(Seam::Chain))
        .encode()
        .unwrap();
    match HelperReader::new(Cursor::new(chain)).read_frame() {
        Ok(Some(HelperFrame::Break(seam))) => {
            assert_eq!(seam.check(&StreamControl::new()), Ok(Seam::Chain))
        }
        other => panic!("{other:?}"),
    }
}
