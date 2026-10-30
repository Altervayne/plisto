/*
 * Reading embedded album art out of an audio file. `read_with_art` is the one place a file is
 * opened for art: the scan decides `has_embedded_cover` from it and the command-time reader
 * pulls the picture bytes from it, so both always agree. MP4-family files read their pictures
 * from the Ilst `covr` atom, which lofty's generic tag conversion drops; every other format
 * reads them from its primary tag. Read-only: the audio file is only opened, never written.
 */

// -- Library Imports --
use std::path::Path;

use lofty::config::ParseOptions;
use lofty::error::FileParseError;
use lofty::file::{FileType, TaggedFile};
use lofty::mp4::Mp4File;
use lofty::picture::{Picture, PictureType};
use lofty::prelude::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;

/// A parsed audio file plus the embedded pictures it carries.
pub struct ArtFile {
    tagged: TaggedFile,
    // Set for MP4-family files only; None means read the pictures from the primary tag.
    mp4_pictures: Option<Vec<Picture>>,
}

impl ArtFile {
    /// The parsed file, for its tags and properties.
    pub fn tagged(&self) -> &TaggedFile {
        &self.tagged
    }

    /// Every embedded picture, in file order.
    pub fn pictures(&self) -> &[Picture] {
        match &self.mp4_pictures {
            Some(pictures) => pictures,
            None => self
                .tagged
                .primary_tag()
                .or_else(|| self.tagged.first_tag())
                .map_or(&[], |tag| tag.pictures()),
        }
    }

    /// The cover picture: a CoverFront frame when present, else the first picture.
    pub fn cover(&self) -> Option<&Picture> {
        let pictures = self.pictures();
        pictures
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .or_else(|| pictures.first())
    }
}

/// Opens `path` once, returning the parsed file and its pictures. The format comes from the
/// extension, as in `lofty::read_from_path`.
pub fn read_with_art(path: &Path) -> Result<ArtFile, FileParseError> {
    let probe = Probe::open(path)?;
    if probe.file_type() != Some(FileType::Mp4) {
        return Ok(ArtFile {
            tagged: probe.read()?,
            mp4_pictures: None,
        });
    }

    let mut reader = probe.into_inner();
    let file = Mp4File::read_from(&mut reader, ParseOptions::default())?;
    let pictures = file
        .ilst()
        .and_then(|ilst| ilst.pictures())
        .map(|pictures| pictures.cloned().collect())
        .unwrap_or_default();
    Ok(ArtFile {
        tagged: file.into(),
        mp4_pictures: Some(pictures),
    })
}

/// Returns the raw bytes of the file's cover picture, or None when lofty cannot open it or it
/// carries no picture.
pub fn read_embedded_cover_bytes(path: &Path) -> Option<Vec<u8>> {
    let art = read_with_art(path).ok()?;
    Some(art.cover()?.data().to_vec())
}

/// Fixtures for tests that need an MP4 file carrying a `covr` atom.
#[cfg(test)]
pub(crate) mod test_support {
    use std::io::Cursor;
    use std::path::Path;

    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use lofty::config::WriteOptions;
    use lofty::mp4::Ilst;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::TagExt;

    // One MP4 atom: big-endian size, fourcc, payload.
    fn atom(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(fourcc);
        out.extend_from_slice(payload);
        out
    }

    /// The smallest MP4 lofty opens: an `ftyp` and a `moov` holding one audio `trak` with just an
    /// `mdhd` and a `soun` `hdlr`, which is what the property reader requires.
    pub fn minimal_mp4() -> Vec<u8> {
        let mut ftyp = b"M4A \0\0\0\0".to_vec();
        ftyp.extend_from_slice(b"M4A mp42isom");

        let mut mdhd = vec![0u8; 24];
        mdhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        let mut hdlr = vec![0u8; 8];
        hdlr.extend_from_slice(b"soun");
        hdlr.extend_from_slice(&[0u8; 13]);

        let mut mdia = atom(b"mdhd", &mdhd);
        mdia.extend(atom(b"hdlr", &hdlr));
        let trak = atom(b"trak", &atom(b"mdia", &mdia));

        let mut file = atom(b"ftyp", &ftyp);
        file.extend(atom(b"moov", &trak));
        file
    }

    /// A solid-colour PNG of the given size, in memory.
    pub fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb([120, 30, 200]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    /// Writes a minimal MP4 at `path` with the given pictures in its `covr` atom, in order.
    pub fn write_mp4_with_pictures(path: &Path, pictures: Vec<Picture>) {
        std::fs::write(path, minimal_mp4()).unwrap();
        let mut ilst = Ilst::new();
        for picture in pictures {
            ilst.insert_picture(picture);
        }
        ilst.save_to_path(path, WriteOptions::default()).unwrap();
    }

    /// A PNG picture; the MP4 `covr` atom has no picture type, so this reads back as `Other`.
    pub fn png_picture(bytes: Vec<u8>) -> Picture {
        Picture::unchecked(bytes)
            .pic_type(PictureType::Other)
            .mime_type(MimeType::Png)
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::covers::thumbnail::thumbnail;
    use lofty::tag::{Tag, TagType};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A unique throwaway file under the system temp dir, removed on drop.
    struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        fn new(ext: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_embedded_{}_{n}_{nanos}.{ext}",
                std::process::id()
            ));
            Self { path }
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    #[test]
    fn unreadable_file_yields_none() {
        // An empty file lofty cannot open carries no picture bytes.
        let file = TempFile::new("mp3");
        fs::write(&file.path, b"").unwrap();
        assert!(read_embedded_cover_bytes(&file.path).is_none());
    }

    #[test]
    fn mp4_cover_round_trips_through_the_helper() {
        let file = TempFile::new("m4a");
        let png = png_bytes(8, 8);
        write_mp4_with_pictures(&file.path, vec![png_picture(png.clone())]);

        let art = read_with_art(&file.path).unwrap();
        assert_eq!(art.pictures().len(), 1);
        assert_eq!(art.cover().unwrap().data(), png.as_slice());
        assert_eq!(read_embedded_cover_bytes(&file.path), Some(png));
    }

    #[test]
    fn mp4_without_a_cover_has_no_picture() {
        let file = TempFile::new("m4a");
        write_mp4_with_pictures(&file.path, Vec::new());
        let art = read_with_art(&file.path).unwrap();
        assert!(art.pictures().is_empty());
        assert!(art.cover().is_none());
    }

    #[test]
    fn the_generic_tag_conversion_drops_the_mp4_cover() {
        let png = png_bytes(8, 8);
        let mut ilst = lofty::mp4::Ilst::new();
        ilst.insert_picture(png_picture(png));
        assert_eq!(ilst.pictures().unwrap().count(), 1, "the Ilst holds the cover");

        let tag: Tag = ilst.into();
        assert_eq!(tag.tag_type(), TagType::Mp4Ilst);
        assert!(tag.pictures().is_empty(), "the generic Tag drops covr");
    }

    // Run against a real file: PLISTO_M4A_SAMPLE=<path> cargo test m4a_sample -- --ignored
    #[test]
    #[ignore]
    fn m4a_sample_art_is_found_and_decodes() {
        let path = std::env::var("PLISTO_M4A_SAMPLE").expect("set PLISTO_M4A_SAMPLE");
        let art = read_with_art(Path::new(&path)).expect("the sample opens");
        assert!(!art.pictures().is_empty(), "no embedded picture found");

        let bytes = read_embedded_cover_bytes(Path::new(&path)).expect("cover bytes");
        let thumb = thumbnail(&bytes, 64).expect("the cover decodes");
        assert!(!thumb.is_empty());
    }
}
