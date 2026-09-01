/*
 * The metadata writer, shared by every producer of an output file. It takes a resolved set of tag
 * values and writes them onto a file in place, embedding a front cover where the format allows and
 * clearing any managed field the caller left empty so a stale value never survives. Export retags
 * each copy through it; the splicer tags each cut segment. `copy_tags` is the inverse the cropper
 * needs: carry a source file's whole primary tag onto a freshly cut file that has none.
 */

// -- Library Imports --
use std::path::Path;

use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, ItemKey, TagExt, TaggedFileExt};
use lofty::tag::{ItemValue, Tag, TagItem, TagType};

/// How a file's art embedding landed. `Embedded` wrote the cover; `Unsupported` skipped it because
/// the format cannot carry embedded art; `NoArt` had no cover to embed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedResult {
    Embedded,
    Unsupported,
    NoArt,
}

/// A failure reading or writing tags on a file. The file is left as it was on a write failure; the
/// source is never touched by `copy_tags`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagError {
    Read,
    Write,
}

impl std::fmt::Display for TagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            TagError::Read => "could not read the file's tags",
            TagError::Write => "could not write the file's tags",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for TagError {}

/// The resolved tag values to write into one output file. Borrowed so nothing is cloned per file.
/// Album, album_artist and year are resolved by the caller; `genres` is the whole managed list,
/// written as a multi-value tag.
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

/// Writes `tags` onto the file at `path` in place, embedding `cover` when the format supports it.
/// Starts from the file's own primary tag (preserving fields not managed here), or a fresh native tag
/// when it has none, and writes the same ItemKeys the scan reads. Returns how the embed landed.
pub fn tag_file(
    path: &Path,
    tags: &TrackTags<'_>,
    cover: Option<&[u8]>,
) -> Result<EmbedResult, TagError> {
    let tagged = lofty::read_from_path(path).map_err(|_| TagError::Read)?;
    let file_type = tagged.file_type();
    let tag_type = tagged.primary_tag_type();
    let mut tag = tagged
        .primary_tag()
        .cloned()
        .unwrap_or_else(|| Tag::new(tag_type));

    write_accessor(&mut tag, tags);
    write_genres(&mut tag, tags.genres);
    set_text(
        &mut tag,
        ItemKey::AlbumArtist,
        tags.album_artist.map(str::to_string),
    );
    set_text(
        &mut tag,
        ItemKey::TrackNumber,
        tags.track_no.map(|n| n.to_string()),
    );
    set_text(
        &mut tag,
        ItemKey::DiscNumber,
        tags.disc_no.map(|n| n.to_string()),
    );
    set_text(&mut tag, ItemKey::Year, tags.year.map(|n| n.to_string()));

    let embed = embed_cover(&mut tag, file_type, tag_type, cover);

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|_| TagError::Write)?;
    Ok(embed)
}

/// Carries the source file's primary tag onto `dest`, so a freshly cut file keeps the metadata the
/// cut itself drops. A source with no primary tag is a no-op. The source is only read.
pub fn copy_tags(source: &Path, dest: &Path) -> Result<(), TagError> {
    let tagged = lofty::read_from_path(source).map_err(|_| TagError::Read)?;
    if let Some(tag) = tagged.primary_tag() {
        tag.save_to_path(dest, WriteOptions::default())
            .map_err(|_| TagError::Write)?;
    }
    Ok(())
}

/// Overlays the splitter's per-track fields onto `output`, which `copy_tags` has already carried the
/// source's whole tag onto. Title is set or, when None (an untitled piece), removed so it does not
/// keep the source's whole-file title; artist is set only when Some, leaving the source's own when
/// None; the track number always lands, each piece being a distinct track. Everything else the source
/// carried (album, album_artist, year, genre, cover, disc) rides through untouched. A file with no tag
/// yet (a WAV source that carried none) gets a fresh native tag holding just these fields.
pub fn retag_split_segment(
    output: &Path,
    title: Option<&str>,
    artist: Option<&str>,
    track_no: i64,
) -> Result<(), TagError> {
    let tagged = lofty::read_from_path(output).map_err(|_| TagError::Read)?;
    let tag_type = tagged.primary_tag_type();
    let mut tag = tagged
        .primary_tag()
        .cloned()
        .unwrap_or_else(|| Tag::new(tag_type));

    match title {
        Some(v) => tag.set_title(v.to_string()),
        None => tag.remove_title(),
    }
    if let Some(v) = artist {
        tag.set_artist(v.to_string());
    }
    set_text(&mut tag, ItemKey::TrackNumber, Some(track_no.to_string()));

    tag.save_to_path(output, WriteOptions::default())
        .map_err(|_| TagError::Write)?;
    Ok(())
}

/// Writes the three accessor fields (title, artist, album), clearing any the caller resolved to None
/// so a stale value never survives. Genre is multi-valued and written through `write_genres`.
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

/// Writes the track's genres as multiple values, clearing any existing genre first so a re-tag never
/// stacks a value onto a stale one. lofty maps `ItemKey::Genre` to each format's native multi-value
/// slot, so pushing each in order lands a real multi-genre tag. An empty slice clears genre entirely.
fn write_genres(tag: &mut Tag, genres: &[String]) {
    tag.remove_key(ItemKey::Genre);
    for genre in genres {
        tag.push(TagItem::new(ItemKey::Genre, ItemValue::Text(genre.clone())));
    }
}

/// Sets or clears one text item by key. A None clears it, so a tag never carries a value the caller
/// does not have.
fn set_text(tag: &mut Tag, key: ItemKey, value: Option<String>) {
    match value {
        Some(v) => {
            tag.insert_text(key, v);
        }
        None => tag.remove_key(key),
    }
}

/// Embeds the cover as the front picture when the format supports it, replacing any existing front
/// cover so a re-tag does not stack art. Formats that cannot carry embedded art (WAV) skip the embed
/// and rely on a folder sidecar.
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
/// fine; WAV (whose native tag would be ID3v2) is treated as embed-unsupported so its art comes from
/// a sidecar.
fn embed_supported(file_type: FileType, tag_type: TagType) -> bool {
    !matches!(file_type, FileType::Wav)
        && matches!(
            tag_type,
            TagType::Id3v2 | TagType::VorbisComments | TagType::Mp4Ilst | TagType::Ape
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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
                .join(format!("plisto_tags_{}_{n}_{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A minimal valid FLAC: the stream marker and a lone STREAMINFO block, enough for lofty to open
    // and rewrite. No audio frames are needed to parse.
    fn minimal_flac() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.push(0x80);
        v.extend_from_slice(&[0x00, 0x00, 0x22]);
        v.extend_from_slice(&[0u8; 34]);
        v
    }

    #[test]
    fn tag_file_writes_and_reads_back() {
        let dir = TempDir::new();
        let path = dir.path.join("a.flac");
        fs::write(&path, minimal_flac()).unwrap();

        let genres = vec!["Ambient".to_string()];
        let tags = TrackTags {
            title: Some("A Title"),
            artist: Some("An Artist"),
            album: Some("An Album"),
            album_artist: Some("The AA"),
            year: Some(2021),
            genres: &genres,
            track_no: Some(3),
            disc_no: Some(1),
        };
        let embed = tag_file(&path, &tags, None).unwrap();
        assert_eq!(embed, EmbedResult::NoArt, "no cover was passed");

        let reopened = lofty::read_from_path(&path).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("A Title"));
        assert_eq!(tag.artist().as_deref(), Some("An Artist"));
        assert_eq!(tag.get_string(ItemKey::AlbumArtist), Some("The AA"));
        assert_eq!(tag.get_string(ItemKey::TrackNumber), Some("3"));
    }

    #[test]
    fn copy_tags_carries_the_primary_tag_onto_a_bare_file() {
        let dir = TempDir::new();
        let source = dir.path.join("src.flac");
        let dest = dir.path.join("dst.flac");
        fs::write(&source, minimal_flac()).unwrap();
        fs::write(&dest, minimal_flac()).unwrap();

        // Tag the source, leave the dest bare, then copy across.
        let tags = TrackTags {
            title: Some("Carried Title"),
            artist: Some("Carried Artist"),
            album: None,
            album_artist: None,
            year: None,
            genres: &[],
            track_no: None,
            disc_no: None,
        };
        tag_file(&source, &tags, None).unwrap();
        copy_tags(&source, &dest).unwrap();

        let reopened = lofty::read_from_path(&dest).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Carried Title"));
        assert_eq!(tag.artist().as_deref(), Some("Carried Artist"));
    }

    // The cropper path: copy_tags must carry the source's whole tag, art included, onto the cut so a
    // trimmed file keeps every field. This is the field the design assumed ffmpeg passed through.
    #[test]
    fn copy_tags_carries_every_field_and_the_cover() {
        let dir = TempDir::new();
        let source = dir.path.join("src.flac");
        let dest = dir.path.join("dst.flac");
        fs::write(&source, minimal_flac()).unwrap();
        fs::write(&dest, minimal_flac()).unwrap();

        let genres = vec!["Jazz".to_string()];
        let tags = TrackTags {
            title: Some("Whole Title"),
            artist: Some("Whole Artist"),
            album: Some("Whole Album"),
            album_artist: Some("Whole AA"),
            year: Some(1998),
            genres: &genres,
            track_no: Some(7),
            disc_no: Some(2),
        };
        let cover = vec![0xFFu8; 64];
        assert_eq!(tag_file(&source, &tags, Some(&cover)).unwrap(), EmbedResult::Embedded);
        copy_tags(&source, &dest).unwrap();

        let reopened = lofty::read_from_path(&dest).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Whole Title"));
        assert_eq!(tag.artist().as_deref(), Some("Whole Artist"));
        assert_eq!(tag.album().as_deref(), Some("Whole Album"));
        assert_eq!(tag.get_string(ItemKey::AlbumArtist), Some("Whole AA"));
        assert_eq!(tag.get_string(ItemKey::Year), Some("1998"));
        assert_eq!(tag.get_string(ItemKey::Genre), Some("Jazz"));
        assert_eq!(tag.get_string(ItemKey::TrackNumber), Some("7"));
        assert_eq!(tag.get_string(ItemKey::DiscNumber), Some("2"));
        assert_eq!(tag.pictures().len(), 1, "the cover rides along");
    }

    // The splitter path: after copy_tags, retag overlays the per-track title and number, sets artist
    // only when given, and leaves every inherited field (album, album_artist, year, genre) in place.
    #[test]
    fn retag_split_segment_overlays_over_the_inherited_tag() {
        let dir = TempDir::new();
        let source = dir.path.join("src.flac");
        let dest = dir.path.join("dst.flac");
        fs::write(&source, minimal_flac()).unwrap();
        fs::write(&dest, minimal_flac()).unwrap();

        let genres = vec!["Jazz".to_string()];
        let tags = TrackTags {
            title: Some("Source Title"),
            artist: Some("Source Artist"),
            album: Some("Source Album"),
            album_artist: Some("Source AA"),
            year: Some(1998),
            genres: &genres,
            track_no: Some(1),
            disc_no: Some(2),
        };
        tag_file(&source, &tags, None).unwrap();
        copy_tags(&source, &dest).unwrap();
        retag_split_segment(&dest, Some("Piece Title"), None, 5).unwrap();

        let reopened = lofty::read_from_path(&dest).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Piece Title"), "title overlaid");
        assert_eq!(tag.get_string(ItemKey::TrackNumber), Some("5"), "number overlaid");
        assert_eq!(
            tag.artist().as_deref(),
            Some("Source Artist"),
            "a None artist keeps the source's own"
        );
        assert_eq!(tag.album().as_deref(), Some("Source Album"));
        assert_eq!(tag.get_string(ItemKey::AlbumArtist), Some("Source AA"));
        assert_eq!(tag.get_string(ItemKey::Year), Some("1998"));
        assert_eq!(tag.get_string(ItemKey::Genre), Some("Jazz"));
    }

    // A None title on the splitter path clears the inherited whole-file title rather than keeping it,
    // while a Some artist replaces the source's.
    #[test]
    fn retag_split_segment_clears_the_title_on_none() {
        let dir = TempDir::new();
        let source = dir.path.join("src.flac");
        let dest = dir.path.join("dst.flac");
        fs::write(&source, minimal_flac()).unwrap();
        fs::write(&dest, minimal_flac()).unwrap();

        let tags = TrackTags {
            title: Some("Source Title"),
            artist: Some("Source Artist"),
            album: None,
            album_artist: None,
            year: None,
            genres: &[],
            track_no: None,
            disc_no: None,
        };
        tag_file(&source, &tags, None).unwrap();
        copy_tags(&source, &dest).unwrap();
        retag_split_segment(&dest, None, Some("New Artist"), 2).unwrap();

        let reopened = lofty::read_from_path(&dest).unwrap();
        let tag = reopened.primary_tag().unwrap();
        assert_eq!(tag.title(), None, "an untitled piece drops the source title");
        assert_eq!(tag.artist().as_deref(), Some("New Artist"), "a Some artist replaces it");
        assert_eq!(tag.get_string(ItemKey::TrackNumber), Some("2"));
    }
}
