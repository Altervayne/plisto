/*
 * The filesystem writer: the one place export touches disk. It resolves a container's full-res
 * cover to JPEG once, drops the folder sidecars, and copies each source into a temp file that is
 * retagged and (where the format allows) art-embedded before an atomic rename swaps it into place.
 * The source and the cover store are read-only; nothing is written outside the destination; a
 * cancel or crash leaves fully-valid files and stray temps, never a torn track.
 */

// -- Library Imports --
use std::fs;
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, ItemKey, TagExt, TaggedFileExt};
use lofty::tag::{ItemValue, Tag, TagItem, TagType};

// -- Local Imports --
use super::plan::CoverPlan;
use crate::covers::{
    discover_adjacent_images, full_res_cache_path, read_embedded_cover_bytes, resolve_track_cover,
    ResolvedCover,
};

// JPEG quality for the exported full-res cover. Higher than the thumbnail cache, since this art is
// embedded and dropped as a sidecar at full size.
const COVER_JPEG_QUALITY: u8 = 90;

// The sidecar filenames every container folder gets, so a player finds art by either convention.
const SIDECARS: &[&str] = &["cover.jpg", "folder.jpg"];

/// How a track's art embedding landed. `Embedded` wrote the cover; `Unsupported` skipped it
/// because the format cannot carry embedded art; `NoArt` had no cover to embed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedResult {
    Embedded,
    Unsupported,
    NoArt,
}

/// A hard failure writing one track. The source stays untouched; a failed temp is left in place,
/// never cleaned up destructively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportError {
    CopyFailed,
    RetagFailed,
}

/// The resolved tag values to write into one exported file. Borrowed from the plan so nothing is
/// cloned per track. Album, album_artist and year are resolved per track (an override over the
/// container's value); `genres` is the track's whole managed list, written as a multi-value tag.
pub struct TrackTags<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub album_artist: Option<&'a str>,
    pub year: Option<i64>,
    pub genres: &'a [String],
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
}

/// Resolves a container's cover to full-size JPEG bytes, or None when no art is available. Reads
/// the imported blob by hash (integrity-checked), or re-derives a member track's own embedded or
/// adjacent art, then decodes and re-encodes to JPEG once for the sidecar and every embed. The
/// cover store and the source files are only read.
pub fn cover_jpeg(cover: &CoverPlan, covers_dir: &Path) -> Option<Vec<u8>> {
    let raw = match cover {
        CoverPlan::Store {
            content_hash,
            byte_len,
        } => read_stored_blob(covers_dir, content_hash, *byte_len)?,
        CoverPlan::Member {
            source,
            has_embedded,
        } => member_art(source, *has_embedded)?,
        CoverPlan::None => return None,
    };
    encode_jpeg(&raw)
}

/// Writes the folder sidecars (`cover.jpg` and `folder.jpg`) from the shared JPEG, each staged to a
/// temp file and atomically renamed. A failed sidecar is quiet - the embedded art still carries the
/// cover - so it never aborts a container.
pub fn write_sidecars(dir: &Path, jpeg: &[u8]) {
    for name in SIDECARS {
        let final_path = dir.join(name);
        let tmp = dir.join(tmp_name(name));
        if fs::write(&tmp, jpeg).is_ok() {
            let _ = fs::rename(&tmp, &final_path);
        }
    }
}

/// Copies one source into `dir/filename`, retags the copy, embeds the cover where the format
/// allows, and atomically renames it into place. The temp name is `.plisto-tmp-<filename>`; the
/// final file appears only once copy, retag and embed all succeed. Returns how the embed landed.
pub fn export_track(
    source: &str,
    dir: &Path,
    filename: &str,
    tags: &TrackTags<'_>,
    cover: Option<&[u8]>,
) -> Result<EmbedResult, ExportError> {
    let final_path = dir.join(filename);
    let tmp = dir.join(tmp_name(filename));

    fs::copy(source, &tmp).map_err(|_| ExportError::CopyFailed)?;

    // A retag failure leaves the temp behind; the source is never touched, the final never appears.
    let embed = retag(&tmp, tags, cover)?;

    fs::rename(&tmp, &final_path).map_err(|_| ExportError::CopyFailed)?;
    Ok(embed)
}

/// Retags the copy at `path` in place with `tags`, embedding `cover` when the format supports it.
/// Starts from the copy's own primary tag (preserving fields export does not manage), or a fresh
/// native tag when it has none. Writes the same ItemKeys the scan reads.
fn retag(path: &Path, tags: &TrackTags<'_>, cover: Option<&[u8]>) -> Result<EmbedResult, ExportError> {
    let tagged = lofty::read_from_path(path).map_err(|_| ExportError::RetagFailed)?;
    let file_type = tagged.file_type();
    let tag_type = tagged.primary_tag_type();
    let mut tag = tagged
        .primary_tag()
        .cloned()
        .unwrap_or_else(|| Tag::new(tag_type));

    write_accessor(&mut tag, tags);
    write_genres(&mut tag, tags.genres);
    set_text(&mut tag, ItemKey::AlbumArtist, tags.album_artist.map(str::to_string));
    set_text(&mut tag, ItemKey::TrackNumber, tags.track_no.map(|n| n.to_string()));
    set_text(&mut tag, ItemKey::DiscNumber, tags.disc_no.map(|n| n.to_string()));
    set_text(&mut tag, ItemKey::Year, tags.year.map(|n| n.to_string()));

    let embed = embed_cover(&mut tag, file_type, tag_type, cover);

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|_| ExportError::RetagFailed)?;
    Ok(embed)
}

/// Writes the three accessor fields (title, artist, album), clearing any the plan resolved to None
/// so a stale value never survives into the export. Genre is multi-valued now and written through
/// `write_genres`, not the single-value accessor.
fn write_accessor(tag: &mut Tag, tags: &TrackTags<'_>) {
    match tags.title {
        Some(v) => tag.set_title(v.to_string()),
        None => tag.remove_title(),
    }
    match tags.artist {
        Some(v) => tag.set_artist(v.to_string()),
        None => tag.remove_artist(),
    }
    match tags.album {
        Some(v) => tag.set_album(v.to_string()),
        None => tag.remove_album(),
    }
}

/// Writes the track's genres as multiple values, clearing any existing genre first so a re-export
/// never stacks a value onto a stale one. lofty maps `ItemKey::Genre` to each format's native
/// multi-value slot - a null-separated TCON on ID3v2.4, one `GENRE` field per value on Vorbis, a
/// repeated `©gen` atom on MP4 - so pushing each in order lands a real multi-genre tag. An empty
/// slice clears genre entirely, matching the clear-on-None discipline the accessor fields keep.
fn write_genres(tag: &mut Tag, genres: &[String]) {
    tag.remove_key(ItemKey::Genre);
    for genre in genres {
        tag.push(TagItem::new(ItemKey::Genre, ItemValue::Text(genre.clone())));
    }
}

/// Sets or clears one text item by key. A None clears it, so an export never carries a value the
/// plan does not have.
fn set_text(tag: &mut Tag, key: ItemKey, value: Option<String>) {
    match value {
        Some(v) => {
            tag.insert_text(key, v);
        }
        None => tag.remove_key(key),
    }
}

/// Embeds the cover as the front picture when the format supports it, replacing any existing front
/// cover so a re-export does not stack art. Formats that cannot carry embedded art (WAV) skip the
/// embed and rely on the folder sidecar.
fn embed_cover(
    tag: &mut Tag,
    file_type: FileType,
    tag_type: TagType,
    cover: Option<&[u8]>,
) -> EmbedResult {
    let Some(bytes) = cover else {
        return EmbedResult::NoArt;
    };
    if !embed_supported(file_type, tag_type) {
        return EmbedResult::Unsupported;
    }
    tag.remove_picture_type(PictureType::CoverFront);
    let picture = Picture::unchecked(bytes.to_vec())
        .pic_type(PictureType::CoverFront)
        .mime_type(MimeType::Jpeg)
        .build();
    tag.push_picture(picture);
    EmbedResult::Embedded
}

/// Whether a format can carry an embedded front cover. ID3v2, Vorbis Comments, MP4 and APE embed
/// fine; WAV (whose native tag would be ID3v2) is treated as embed-unsupported so its art comes
/// from the sidecar, matching the export's format guarantee.
fn embed_supported(file_type: FileType, tag_type: TagType) -> bool {
    !matches!(file_type, FileType::Wav)
        && matches!(
            tag_type,
            TagType::Id3v2 | TagType::VorbisComments | TagType::Mp4Ilst | TagType::Ape
        )
}

/// Reads and integrity-checks an imported cover's full-res blob straight from the store, without
/// the DB. Mirrors the manifest check: byte length then content hash, so a truncated or swapped
/// blob reads as absent rather than corrupt art.
fn read_stored_blob(covers_dir: &Path, content_hash: &str, byte_len: i64) -> Option<Vec<u8>> {
    let path = full_res_cache_path(covers_dir, content_hash);
    let bytes = fs::read(path).ok()?;
    if bytes.len() as i64 != byte_len {
        return None;
    }
    if blake3::hash(&bytes).to_hex().to_string() != content_hash {
        return None;
    }
    Some(bytes)
}

/// Re-derives a member track's own art, mirroring the resolved-cover precedence: its embedded
/// picture, else the first adjacent image on disk, else nothing. Read-only over the source folder.
fn member_art(source: &str, has_embedded: bool) -> Option<Vec<u8>> {
    let path = Path::new(source);
    let adjacents = discover_adjacent_images(path);
    match resolve_track_cover(false, has_embedded, !adjacents.is_empty()) {
        ResolvedCover::Embedded => read_embedded_cover_bytes(path),
        ResolvedCover::Adjacent => fs::read(adjacents.first()?).ok(),
        ResolvedCover::Folder | ResolvedCover::None => None,
    }
}

/// Decodes art from memory and re-encodes it to JPEG at full size, flattening any alpha JPEG cannot
/// carry. None when the bytes cannot be decoded.
fn encode_jpeg(raw: &[u8]) -> Option<Vec<u8>> {
    let rgb = image::load_from_memory(raw).ok()?.to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, COVER_JPEG_QUALITY)
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .ok()?;
    Some(out)
}

/// The temp filename a final name is staged under, so a reader never sees a half-written file.
fn tmp_name(filename: &str) -> String {
    format!(".plisto-tmp-{filename}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plisto_export_{}_{n}_{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A solid-colour JPEG, in memory, to embed and re-encode.
    fn jpeg_bytes() -> Vec<u8> {
        let img = RgbImage::from_pixel(24, 24, Rgb([180, 60, 20]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Jpeg)
            .unwrap();
        buf.into_inner()
    }

    // A minimal valid FLAC: the stream marker and a lone STREAMINFO block, enough for lofty to open
    // and rewrite. No audio frames are needed to parse.
    fn minimal_flac() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.push(0x80); // last metadata block, type 0 (STREAMINFO)
        v.extend_from_slice(&[0x00, 0x00, 0x22]); // 34-byte content
        v.extend_from_slice(&[0u8; 34]);
        v
    }

    // A minimal valid PCM WAV with a small silent data chunk, complete enough for lofty to open and
    // rewrite. Mono 16-bit, four samples of silence.
    fn minimal_wav() -> Vec<u8> {
        let data = [0u8; 8];
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1u16.to_le_bytes()); // mono
        v.extend_from_slice(&44_100u32.to_le_bytes());
        v.extend_from_slice(&88_200u32.to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(&data);
        v
    }

    #[test]
    fn flac_round_trip_writes_tags_and_embeds_art() {
        let dir = TempDir::new();
        let source = dir.path.join("in.flac");
        fs::write(&source, minimal_flac()).unwrap();

        let jpeg = encode_jpeg(&jpeg_bytes()).unwrap();
        let genres = vec!["Ambient".to_string(), "Downtempo".to_string()];
        let tags = TrackTags {
            title: Some("Exported Title"),
            artist: Some("Exported Artist"),
            album: Some("Exported Album"),
            album_artist: Some("Exported AA"),
            year: Some(2021),
            genres: &genres,
            track_no: Some(4),
            disc_no: Some(1),
        };

        let embed = export_track(
            &source.to_string_lossy(),
            &dir.path,
            "04 - Exported Title.flac",
            &tags,
            Some(&jpeg),
        )
        .unwrap();
        assert_eq!(embed, EmbedResult::Embedded);

        // The final file exists, the temp is gone, and the source is untouched.
        let out = dir.path.join("04 - Exported Title.flac");
        assert!(out.exists());
        assert!(!dir.path.join(".plisto-tmp-04 - Exported Title.flac").exists());

        // Reopen and confirm the tags and the embedded front cover landed.
        let reopened = lofty::read_from_path(&out).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Exported Title"));
        assert_eq!(tag.artist().as_deref(), Some("Exported Artist"));
        assert_eq!(tag.album().as_deref(), Some("Exported Album"));
        assert_eq!(tag.get_string(ItemKey::AlbumArtist), Some("Exported AA"));
        assert_eq!(tag.get_string(ItemKey::TrackNumber), Some("4"));
        assert_eq!(tag.get_string(ItemKey::Year), Some("2021"));
        let read_genres: Vec<&str> = tag.get_strings(ItemKey::Genre).collect();
        assert_eq!(read_genres, vec!["Ambient", "Downtempo"], "both genres round-trip");
        assert!(
            tag.pictures().iter().any(|p| p.pic_type() == PictureType::CoverFront),
            "a front cover is embedded",
        );
    }

    #[test]
    fn wav_copies_and_retags_but_skips_the_embed() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        fs::write(&source, minimal_wav()).unwrap();

        let jpeg = encode_jpeg(&jpeg_bytes()).unwrap();
        let tags = TrackTags {
            title: Some("Wav Title"),
            artist: Some("Wav Artist"),
            album: None,
            album_artist: None,
            year: None,
            genres: &[],
            track_no: Some(1),
            disc_no: None,
        };

        let embed = export_track(
            &source.to_string_lossy(),
            &dir.path,
            "01 - Wav Title.wav",
            &tags,
            Some(&jpeg),
        )
        .unwrap();
        assert_eq!(embed, EmbedResult::Unsupported, "WAV skips the embed");

        let out = dir.path.join("01 - Wav Title.wav");
        assert!(out.exists());
        let reopened = lofty::read_from_path(&out).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Wav Title"));
        assert!(
            tag.pictures().is_empty(),
            "no art is embedded in a WAV",
        );
    }

    #[test]
    fn sidecars_are_written_from_the_shared_jpeg() {
        let dir = TempDir::new();
        let jpeg = encode_jpeg(&jpeg_bytes()).unwrap();
        write_sidecars(&dir.path, &jpeg);
        assert!(dir.path.join("cover.jpg").exists());
        assert!(dir.path.join("folder.jpg").exists());
    }

    #[test]
    fn a_missing_source_is_a_copy_failure() {
        let dir = TempDir::new();
        let tags = TrackTags {
            title: Some("X"),
            artist: None,
            album: None,
            album_artist: None,
            year: None,
            genres: &[],
            track_no: None,
            disc_no: None,
        };
        let result = export_track("/no/such/file.mp3", &dir.path, "x.mp3", &tags, None);
        assert_eq!(result, Err(ExportError::CopyFailed));
    }
}
