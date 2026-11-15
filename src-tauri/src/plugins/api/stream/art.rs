/*
 * A stream's artwork from bytes: checked, decoded once, then re-encoded into the covers cache by
 * content hash at both thumb sizes, so the windows only ever load Plisto's own thumbnail files.
 * Formats are the image decoder's built set; SVG and anything else, an image over `ART_EDGE_MAX` on
 * a side or over `ART_PIXELS_MAX` in all, fail quietly: the item keeps the artwork it had. The size
 * is read from the header before any decode, and the decoder itself is held to the same sizes and
 * to `ART_ALLOC_MAX`, so a header that lies cannot make it allocate past them.
 *
 * One decode runs at a time for the whole app, on a thread of its own, never under the hub lock. An
 * item keeps only its latest request, at most one decode starts per `ART_GAP` for it, and every
 * request or clear takes a new generation: a result for an older generation or an item that is gone
 * is dropped.
 */

// -- Library Imports --
use std::io::Cursor;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageReader, Limits};

// -- Local Imports --
use super::hub::{publish, Session, StreamHub};
use super::link::StreamLink;
use crate::adhoc::AdHocCover;
use crate::covers::read_image_dimensions;

/// The longest side an artwork image may have.
pub const ART_EDGE_MAX: u32 = 8_192;
/// The most pixels an artwork image may have: 4096 x 4096.
pub const ART_PIXELS_MAX: u64 = 16_777_216;
/// The most the decoder may allocate for one artwork image.
const ART_ALLOC_MAX: u64 = 128 << 20;
/// The least time between two artwork decodes of one item.
pub(super) const ART_GAP: Duration = Duration::from_secs(5);

fn fits(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= ART_EDGE_MAX
        && height <= ART_EDGE_MAX
        && u64::from(width) * u64::from(height) <= ART_PIXELS_MAX
}

/// Decodes `bytes` within the limits. None when they are not an image that fits.
fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let (width, height) = read_image_dimensions(bytes).ok()?;
    if !fits(width, height) {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(ART_EDGE_MAX);
    limits.max_image_height = Some(ART_EDGE_MAX);
    limits.max_alloc = Some(ART_ALLOC_MAX);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    fits(image.width(), image.height()).then_some(image)
}

/// Caches `bytes` as artwork thumbnails. None when they are not a usable image.
pub fn thumbnail(link: &dyn StreamLink, bytes: &[u8]) -> Option<AdHocCover> {
    let image = decode(bytes)?;
    let hash = blake3::hash(bytes).to_hex().to_string();
    link.cache_art(&hash, &image).then(|| AdHocCover {
        hash,
        width: i64::from(image.width()),
        height: i64::from(image.height()),
    })
}

impl StreamHub {
    /// Asks for `bytes` as the seated item's artwork, replacing any request still waiting.
    pub(super) fn want_art(
        &self,
        session: &mut Session,
        bytes: Vec<u8>,
        link: &Arc<dyn StreamLink>,
        now: Instant,
    ) {
        if let Some(item) = session.item.as_mut() {
            item.art.generation += 1;
            item.art.pending = Some(bytes);
        }
        self.pump_art(session, link, now);
    }

    /// Starts the seated item's waiting request when no decode runs and its gap has passed.
    pub(super) fn pump_art(&self, session: &mut Session, link: &Arc<dyn StreamLink>, now: Instant) {
        if session.art_busy {
            return;
        }
        let Some(item) = session.item.as_mut() else {
            return;
        };
        let due = item
            .art
            .last
            .is_none_or(|last| now.saturating_duration_since(last) >= ART_GAP);
        if !due {
            return;
        }
        let Some(bytes) = item.art.pending.take() else {
            return;
        };
        item.art.last = Some(now);
        let (id, generation) = (item.id, item.art.generation);
        let (hub, link) = (Arc::downgrade(&self.0), Arc::clone(link));
        session.art_busy = thread::Builder::new()
            .name("plisto-stream-art".into())
            .spawn(move || {
                let cover = thumbnail(&*link, &bytes);
                if let Some(shared) = hub.upgrade() {
                    StreamHub(shared).art_done(id, generation, cover);
                }
            })
            .is_ok();
    }

    /// A decode for item `id` at `generation` ended. A failure keeps the artwork shown before.
    fn art_done(&self, id: i64, generation: u64, cover: Option<AdHocCover>) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        session.art_busy = false;
        if let Some(item) = session.item.as_mut() {
            if item.id == id && item.art.generation == generation {
                if let Some(cover) = cover {
                    item.cover = Some(cover);
                    item.art_rev += 1;
                    item.rev += 1;
                    publish(&*link, item);
                }
            }
        }
        self.pump_art(&mut session, &link, Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The CRC-32 a PNG chunk carries over its type and data.
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn chunk(png: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
        let mut body = kind.to_vec();
        body.extend(data);
        png.extend((data.len() as u32).to_be_bytes());
        png.extend(&body);
        png.extend(crc32(&body).to_be_bytes());
    }

    /// A PNG with a header claiming `width` x `height` and no pixel data.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut header = width.to_be_bytes().to_vec();
        header.extend(height.to_be_bytes());
        header.extend([8, 2, 0, 0, 0]);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut png, b"IHDR", &header);
        chunk(&mut png, b"IDAT", &[]);
        chunk(&mut png, b"IEND", &[]);
        png
    }

    #[test]
    fn an_image_over_the_pixel_cap_is_refused_from_its_header() {
        assert!(fits(4_096, 4_096));
        assert!(fits(8_192, 2_048));
        assert!(!fits(4_096, 4_097));
        assert!(!fits(8_193, 1));
        assert!(!fits(0, 10));
        let over = png_header(4_096, 4_097);
        // The header reads; the cap refuses it before the decoder is built.
        assert_eq!(read_image_dimensions(&over).unwrap(), (4_096, 4_097));
        assert!(decode(&over).is_none());
    }
}
