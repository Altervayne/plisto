/*
 * The image engine: decode art from memory, shrink it to a bounded square, and re-encode as
 * JPEG. Pure and deterministic - the same bytes and edge always produce the same output - so a
 * thumbnail can be cached by content hash and regenerated identically on demand.
 */

// -- Library Imports --
use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageError, ImageReader};

// JPEG quality for generated thumbnails. High enough that the shrink, not the codec, is what
// the eye sees; low enough to keep the cache small.
const JPEG_QUALITY: u8 = 82;

/// Decodes `raw_bytes`, scales it so its longest edge is at most `max_edge` (aspect preserved),
/// flattens any alpha, and encodes JPEG. Returns the encoded bytes, or an error when the source
/// cannot be decoded. Never mutates anything on disk.
#[allow(dead_code)]
pub fn thumbnail(raw_bytes: &[u8], max_edge: u32) -> Result<Vec<u8>, ImageError> {
    let decoded = image::load_from_memory(raw_bytes)?;

    // thumbnail() fits the image inside the box while keeping aspect, so a square box bounds the
    // longest edge. to_rgb8 drops alpha, which JPEG cannot carry.
    let rgb = decoded.thumbnail(max_edge, max_edge).to_rgb8();

    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

/// Reads an image's pixel dimensions from its header without a full decode, so a cheap size
/// check does not pay to decode the whole frame.
#[allow(dead_code)]
pub fn read_image_dimensions(raw_bytes: &[u8]) -> Result<(u32, u32), ImageError> {
    let reader = ImageReader::new(Cursor::new(raw_bytes)).with_guessed_format()?;
    reader.into_dimensions()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};

    // A solid-colour PNG of the given size, in memory.
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb([120, 30, 200]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn dimensions_read_from_header() {
        let bytes = png_bytes(40, 20);
        assert_eq!(read_image_dimensions(&bytes).unwrap(), (40, 20));
    }

    #[test]
    fn thumbnail_bounds_the_longest_edge() {
        let bytes = png_bytes(40, 20);
        let thumb = thumbnail(&bytes, 16).unwrap();

        // The output is JPEG: it starts with the SOI marker and decodes.
        assert_eq!(&thumb[..2], &[0xFF, 0xD8]);
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert!(decoded.width().max(decoded.height()) <= 16);
    }

    #[test]
    fn undecodable_bytes_error() {
        assert!(thumbnail(b"not an image", 16).is_err());
    }
}
