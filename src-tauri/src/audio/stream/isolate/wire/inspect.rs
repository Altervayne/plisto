/*
 * The frames of an inspecting helper, two steps per file. `Inspect` asks for one file's tags and
 * `Inspected` answers it, saying whether the file carries a picture; `Cover` then asks for the cover,
 * the file's own picture or the image main offers beside it, and `Covered` answers it. A cover crosses
 * as two thumbnails of RGB8 pixels, already scaled, never as the picture's own bytes, so main decodes
 * nothing a file carries. Every size is checked before the pixels it governs are read, and `Cover`
 * refuses a pair of edges whose largest answer would not fit one frame.
 */

// -- Library Imports --
use std::io::Read;
use std::ops::RangeInclusive;

// -- Local Imports --
use super::decode::{read_hint, Payload};
use super::encode::{push_option, put_hint};
use super::*;

/// The longest tag text an `Inspected` carries, in bytes.
pub const TEXT_MAX: usize = 1024;

/// The longest edge a thumbnail may be asked for.
pub const EDGE_MAX: u32 = 512;

/// The longest edge of a cover's source image the helper reports.
pub const SOURCE_EDGE_MAX: u32 = 65_535;

// Hint flag, hint length and hint, length.
pub(super) const INSPECT_LEN: RangeInclusive<u32> = 9..=(2 + HINT_MAX as u32 + 8);
// Image flag and length, two edges.
pub(super) const COVER_LEN: RangeInclusive<u32> = 9..=17;
// Answer tag, four texts with their flags and lengths, duration flag and value, picture flag.
pub(super) const INSPECTED_LEN: RangeInclusive<u32> = 1..=(1 + 4 * (3 + TEXT_MAX as u32) + 9 + 1);

// Cover flag and source size: an answer's size before its thumbnails.
const COVERED_HEAD: usize = 1 + 8;
// A thumbnail's width and height.
const THUMB_HEAD: usize = 8;
const _: () = assert!(TEXT_MAX <= u16::MAX as usize);

/// One file's tags to read. `len` is the file's length.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inspect {
    /// The file's extension, lowercase, which picks the tag reader.
    pub hint: Option<String>,
    pub len: u64,
}

/// What an inspecting helper found in one file's tags.
#[derive(Clone, Debug, PartialEq)]
pub enum Inspected {
    /// The file does not open as audio.
    Unreadable,
    Read(InspectedFile),
}

/// A readable file's tags, as their raw text, and whether it carries a picture of its own.
#[derive(Clone, Debug, PartialEq)]
pub struct InspectedFile {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub track_gain: Option<String>,
    pub track_peak: Option<String>,
    pub duration_secs: Option<f64>,
    pub has_picture: bool,
}

/// The cover of the file last inspected: its own picture, else the image main serves as
/// `ReadSource::Image` when `image_len` is given. `edges` are the thumbnails asked for, in the
/// order the answer returns them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cover {
    pub image_len: Option<u64>,
    pub edges: [u32; 2],
}

/// A cover's source size and its thumbnails, one per edge asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InspectedCover {
    pub width: u32,
    pub height: u32,
    pub thumbs: [Thumb; 2],
}

/// One thumbnail: `width x height` RGB8 pixels, row by row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thumb {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// The edges, once each is within 1..=`EDGE_MAX` and the largest answer to them fits one frame.
pub fn check_edges(edges: [u32; 2]) -> Result<[u32; 2], WireError> {
    let mut size = COVERED_HEAD;
    for edge in edges {
        if !(1..=EDGE_MAX).contains(&edge) {
            return Err(WireError::BadEdge(edge));
        }
        size += THUMB_HEAD + (edge as usize).pow(2) * 3;
    }
    if size > WIRE_FRAME_MAX as usize {
        return Err(WireError::BadEdge(edges[0].max(edges[1])));
    }
    Ok(edges)
}

fn check_text(text: &str) -> Result<&str, WireError> {
    if text.len() > TEXT_MAX {
        return Err(WireError::TextTooLong(text.len()));
    }
    Ok(text)
}

fn check_size(width: u32, height: u32, max: u32) -> Result<(), WireError> {
    if !(1..=max).contains(&width) || !(1..=max).contains(&height) {
        return Err(WireError::BadImageSize { width, height });
    }
    Ok(())
}

pub(super) fn put_inspect(out: &mut Vec<u8>, inspect: &Inspect) -> Result<(), WireError> {
    put_hint(out, inspect.hint.as_deref())?;
    out.extend(inspect.len.to_le_bytes());
    Ok(())
}

pub(super) fn read_inspect<R: Read>(p: &mut Payload<'_, R>) -> Result<Inspect, WireError> {
    Ok(Inspect {
        hint: read_hint(p)?,
        len: p.u64()?,
    })
}

pub(super) fn put_cover(out: &mut Vec<u8>, cover: &Cover) -> Result<(), WireError> {
    let edges = check_edges(cover.edges)?;
    push_option(out, cover.image_len.map(u64::to_le_bytes));
    for edge in edges {
        out.extend(edge.to_le_bytes());
    }
    Ok(())
}

pub(super) fn read_cover<R: Read>(p: &mut Payload<'_, R>) -> Result<Cover, WireError> {
    Ok(Cover {
        image_len: if p.flag("image")? {
            Some(p.u64()?)
        } else {
            None
        },
        edges: check_edges([p.u32()?, p.u32()?])?,
    })
}

pub(super) fn put_inspected(out: &mut Vec<u8>, inspected: &Inspected) -> Result<(), WireError> {
    let file = match inspected {
        Inspected::Unreadable => {
            out.push(0);
            return Ok(());
        }
        Inspected::Read(file) => file,
    };
    out.push(1);
    for text in [
        &file.title,
        &file.artist,
        &file.track_gain,
        &file.track_peak,
    ] {
        match text {
            Some(text) => {
                let text = check_text(text)?;
                out.push(1);
                out.extend((text.len() as u16).to_le_bytes());
                out.extend(text.as_bytes());
            }
            None => out.push(0),
        }
    }
    let duration = file.duration_secs.map(check_duration).transpose()?;
    push_option(out, duration.map(f64::to_le_bytes));
    out.push(u8::from(file.has_picture));
    Ok(())
}

pub(super) fn read_inspected<R: Read>(p: &mut Payload<'_, R>) -> Result<Inspected, WireError> {
    if p.tag("inspected", 2)? == 0 {
        return Ok(Inspected::Unreadable);
    }
    let [title, artist, track_gain, track_peak] =
        [read_text(p)?, read_text(p)?, read_text(p)?, read_text(p)?];
    let duration_secs = if p.flag("duration")? {
        Some(check_duration(p.f64()?)?)
    } else {
        None
    };
    Ok(Inspected::Read(InspectedFile {
        title,
        artist,
        track_gain,
        track_peak,
        duration_secs,
        has_picture: p.flag("picture")?,
    }))
}

pub(super) fn put_covered(
    out: &mut Vec<u8>,
    cover: &Option<InspectedCover>,
) -> Result<(), WireError> {
    let Some(cover) = cover else {
        out.push(0);
        return Ok(());
    };
    check_size(cover.width, cover.height, SOURCE_EDGE_MAX)?;
    out.push(1);
    out.extend(cover.width.to_le_bytes());
    out.extend(cover.height.to_le_bytes());
    for thumb in &cover.thumbs {
        check_size(thumb.width, thumb.height, EDGE_MAX)?;
        if thumb.rgb.len() != thumb.width as usize * thumb.height as usize * 3 {
            return Err(WireError::BadImageSize {
                width: thumb.width,
                height: thumb.height,
            });
        }
        out.extend(thumb.width.to_le_bytes());
        out.extend(thumb.height.to_le_bytes());
        out.extend(&thumb.rgb);
    }
    Ok(())
}

pub(super) fn read_covered<R: Read>(
    p: &mut Payload<'_, R>,
) -> Result<Option<InspectedCover>, WireError> {
    if !p.flag("cover")? {
        return Ok(None);
    }
    let (width, height) = (p.u32()?, p.u32()?);
    check_size(width, height, SOURCE_EDGE_MAX)?;
    Ok(Some(InspectedCover {
        width,
        height,
        thumbs: [read_thumb(p)?, read_thumb(p)?],
    }))
}

fn read_text<R: Read>(p: &mut Payload<'_, R>) -> Result<Option<String>, WireError> {
    if !p.flag("text")? {
        return Ok(None);
    }
    let len = usize::from(p.u16()?);
    if len > TEXT_MAX {
        return Err(WireError::TextTooLong(len));
    }
    String::from_utf8(p.bytes(len)?)
        .map(Some)
        .map_err(|_| WireError::TextNotUtf8)
}

fn read_thumb<R: Read>(p: &mut Payload<'_, R>) -> Result<Thumb, WireError> {
    let (width, height) = (p.u32()?, p.u32()?);
    check_size(width, height, EDGE_MAX)?;
    // Both edges are checked, so this is at most 768 KiB; `bytes` refuses it past the payload.
    let len = width as usize * height as usize * 3;
    Ok(Thumb {
        width,
        height,
        rgb: p.bytes(len)?,
    })
}
