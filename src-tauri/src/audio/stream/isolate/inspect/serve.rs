/*
 * The inspecting helper's side. For each `Inspect` it runs the tag read the library scan runs, over
 * bytes main serves a read at a time, and keeps the file's own picture; a `Cover` then decodes that
 * picture, else the image main offers beside the file, scaled to each edge asked for exactly as the
 * cover cache scales it, so main only encodes the pixels it receives. The image header is read
 * first, and an image over `COVER_PIXELS_MAX` is never decoded.
 *
 * Main's frames are read on a thread of their own: the answers to reads go to the byte sources, the
 * requests to the answering loop. When main's pipe closes the loop ends and the helper exits. A panic
 * or an abort while parsing ends the helper; main decides what that costs the file.
 */

// -- Library Imports --
use std::io::{BufReader, Read};
use std::sync::Arc;
use std::thread;

use crossbeam_channel::{Receiver, Sender};
use image::{DynamicImage, ImageResult};
use lofty::file::FileType;
use lofty::probe::Probe;

// -- Local Imports --
use crate::audio::stream::isolate::helper::{send, Outlet, EXIT_FAILED, EXIT_OK};
use crate::audio::stream::isolate::remote_source::RemoteSource;
use crate::audio::stream::isolate::wire::{
    Cover, HelperFrame, Inspect, Inspected, InspectedCover, InspectedFile, MainFrame, MainReader,
    ReadSource, Thumb, READ_MAX, SOURCE_EDGE_MAX, TEXT_MAX,
};
use crate::covers::{read_art_from, read_image_dimensions, scale_thumb};
use crate::scan::raw_from_art;

/// The most pixels a cover may have to be decoded. A 10,000 x 10,000 RGBA PNG and a baseline JPEG
/// of that size were measured within the cover step's budgets and the helper's memory cap; a decode
/// that passes the cap all the same ends the helper as a memory kill, which costs only the cover.
pub const COVER_PIXELS_MAX: u64 = 100_000_000;

/// One request from main.
enum Ask {
    Tags(Inspect),
    Cover(Cover),
}

/// Answers `first`, then every later request main sends, until main's pipe closes.
pub(in crate::audio::stream::isolate) fn serve(
    first: Inspect,
    reader: MainReader<BufReader<impl Read + Send + 'static>>,
    out: Outlet,
) -> i32 {
    let (reply_tx, replies) = crossbeam_channel::bounded(1);
    let (ask_tx, asks) = crossbeam_channel::bounded(1);
    let routed = thread::Builder::new()
        .name("plisto-inspect-demux".into())
        .spawn(move || route(reader, reply_tx, ask_tx));
    if routed.is_err() {
        return EXIT_FAILED;
    }
    let mut next = Some(Ask::Tags(first));
    // The picture of the file last read, for its cover step.
    let mut picture: Option<Vec<u8>> = None;
    #[cfg(test)]
    let mut answered = false;
    loop {
        let ask = match next.take() {
            Some(ask) => ask,
            None => match asks.recv() {
                Ok(ask) => ask,
                Err(_) => return EXIT_OK,
            },
        };
        let answer = match ask {
            Ask::Tags(ask) => {
                #[cfg(test)]
                fault_before_tags(&out, &ask);
                let (answer, own) = read_tags(&out, &replies, &ask);
                picture = own;
                #[cfg(test)]
                if let Some(wrong) = fault_after_tags(&answer, answered) {
                    let _ = send(&out, &wrong);
                    continue;
                }
                HelperFrame::Inspected(answer)
            }
            Ask::Cover(ask) => {
                #[cfg(test)]
                fault_in_cover();
                let bytes = picture.take().or_else(|| {
                    ask.image_len
                        .and_then(|len| read_image(&out, &replies, len))
                });
                HelperFrame::Covered(
                    bytes.and_then(|bytes| scaled_with(&bytes, ask.edges, image::load_from_memory)),
                )
            }
        };
        if send(&out, &answer).is_err() {
            return EXIT_FAILED;
        }
        #[cfg(test)]
        {
            exit_after(&answer);
            answered = true;
        }
    }
}

// Routes main's frames until its pipe closes or a frame comes that an inspecting helper never takes.
fn route(
    mut reader: MainReader<BufReader<impl Read>>,
    replies: Sender<MainFrame>,
    asks: Sender<Ask>,
) {
    while let Ok(Some(frame)) = reader.read_frame() {
        let routed = match frame {
            MainFrame::Data(_) | MainFrame::Eof | MainFrame::Broken => replies.send(frame).is_ok(),
            MainFrame::Inspect(ask) => asks.send(Ask::Tags(ask)).is_ok(),
            MainFrame::Cover(ask) => asks.send(Ask::Cover(ask)).is_ok(),
            _ => false,
        };
        if !routed {
            return;
        }
    }
}

// One file's tags, and its own picture's bytes when it has one.
fn read_tags(
    out: &Outlet,
    replies: &Receiver<MainFrame>,
    ask: &Inspect,
) -> (Inspected, Option<Vec<u8>>) {
    let audio = RemoteSource::new(Arc::clone(out), replies.clone(), true, Some(ask.len));
    let probe = Probe::new(BufReader::with_capacity(READ_MAX as usize, audio));
    // The format comes from the extension, as it does for a file the scan reads by its path.
    let probe = match ask.hint.as_deref().and_then(FileType::from_ext) {
        Some(file_type) => probe.set_file_type(file_type),
        None => probe,
    };
    let Ok(art) = read_art_from(probe) else {
        return (Inspected::Unreadable, None);
    };
    let raw = raw_from_art(&art);
    let picture = art.cover().map(|picture| picture.data().to_vec());
    let file = InspectedFile {
        title: raw.title.map(clip),
        artist: raw.artist.map(clip),
        track_gain: raw.rg_track_gain.map(clip),
        track_peak: raw.rg_track_peak.map(clip),
        duration_secs: raw.duration_secs.filter(|d| d.is_finite() && *d >= 0.0),
        has_picture: picture.is_some(),
    };
    (Inspected::Read(file), picture)
}

// The image beside the file, whole.
fn read_image(out: &Outlet, replies: &Receiver<MainFrame>, len: u64) -> Option<Vec<u8>> {
    let mut image = RemoteSource::new(Arc::clone(out), replies.clone(), true, Some(len))
        .reading(ReadSource::Image);
    let mut bytes = Vec::with_capacity(usize::try_from(len).ok()?);
    image.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// The picture decoded by `decode` and scaled to each edge, or None when its header does not read,
/// its size is out of bounds or over `COVER_PIXELS_MAX`, or it does not decode to that size. The
/// header is checked before `decode` runs.
pub(in crate::audio::stream::isolate) fn scaled_with(
    bytes: &[u8],
    edges: [u32; 2],
    decode: impl FnOnce(&[u8]) -> ImageResult<DynamicImage>,
) -> Option<InspectedCover> {
    let (width, height) = read_image_dimensions(bytes).ok()?;
    if !(1..=SOURCE_EDGE_MAX).contains(&width)
        || !(1..=SOURCE_EDGE_MAX).contains(&height)
        || u64::from(width) * u64::from(height) > COVER_PIXELS_MAX
    {
        return None;
    }
    let decoded = decode(bytes).ok()?;
    if (decoded.width(), decoded.height()) != (width, height) {
        return None;
    }
    let thumbs = edges.map(|edge| {
        let rgb = scale_thumb(&decoded, edge);
        Thumb {
            width: rgb.width(),
            height: rgb.height(),
            rgb: rgb.into_raw(),
        }
    });
    Some(InspectedCover {
        width,
        height,
        thumbs,
    })
}

// A tag text cut to `TEXT_MAX` bytes on a character boundary.
fn clip(mut text: String) -> String {
    if text.len() > TEXT_MAX {
        let mut end = TEXT_MAX;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

#[cfg(test)]
fn marked(answer: &Inspected) -> bool {
    use crate::audio::stream::isolate::test_faults::MARKED_TITLE;
    matches!(answer, Inspected::Read(file) if file.title.as_deref() == Some(MARKED_TITLE))
}

// Stops dead: no CPU, no request, until the job kills the helper.
#[cfg(test)]
fn park() -> ! {
    loop {
        thread::park();
    }
}

#[cfg(test)]
fn fault_before_tags(out: &Outlet, ask: &Inspect) {
    use crate::audio::stream::isolate::test_faults::{
        inspect_fault, InspectFault, DOUBLE_READ_HINT,
    };
    if inspect_fault() == Some(InspectFault::DoubleRead)
        && ask.hint.as_deref() == Some(DOUBLE_READ_HINT)
    {
        let read = HelperFrame::Read {
            source: ReadSource::Audio,
            pos: 0,
            max: 16,
        };
        let _ = send(out, &read).and_then(|()| send(out, &read));
        park();
    }
}

// What the helper does instead of answering a marked file's tags, if anything.
#[cfg(test)]
fn fault_after_tags(answer: &Inspected, answered: bool) -> Option<HelperFrame> {
    use crate::audio::stream::isolate::test_faults::{inspect_fault, InspectFault};
    if !marked(answer) {
        return None;
    }
    match inspect_fault()? {
        InspectFault::Abort => std::process::abort(),
        InspectFault::AbortReused if answered => std::process::abort(),
        InspectFault::Idle => park(),
        InspectFault::IdleReused if answered => park(),
        InspectFault::WrongAnswer => Some(HelperFrame::Covered(None)),
        _ => None,
    }
}

#[cfg(test)]
fn fault_in_cover() {
    use crate::audio::stream::isolate::test_faults::{burn, inspect_fault, InspectFault};
    match inspect_fault() {
        Some(InspectFault::CoverSpin) => burn(),
        Some(InspectFault::CoverPark) => park(),
        Some(InspectFault::CoverHog) => {
            // Past the helper's memory cap: the allocator ends the helper.
            let hog = vec![1u8; 2 << 30];
            std::hint::black_box(hog);
        }
        _ => {}
    }
}

#[cfg(test)]
fn exit_after(answer: &HelperFrame) {
    use crate::audio::stream::isolate::test_faults::{inspect_fault, InspectFault};
    if inspect_fault() == Some(InspectFault::ExitAfter)
        && matches!(answer, HelperFrame::Inspected(file) if marked(file))
    {
        std::process::exit(EXIT_OK);
    }
}
