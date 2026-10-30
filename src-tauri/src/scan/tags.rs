/*
 * Reading one file's tags with lofty. Numeric tags (track, disc, year) are pulled as their
 * raw strings, not lofty's parsed integers, so the single numeric-parsing boundary stays in
 * normalize.rs. A file lofty cannot open is not dropped: it yields default (all-None) tags and
 * an error flag, so the caller still indexes it from its path and stats and counts it.
 */

// -- Library Imports --
use std::path::Path;

use lofty::prelude::{Accessor, AudioFile, ItemKey, TaggedFileExt};

// -- Cover Imports --
use crate::covers::read_with_art;

// -- Type Imports --
use crate::model::RawTags;

/// Reads the primary tag and duration from one file. Returns the tags plus a flag that is true
/// when lofty could not parse the file, in which case the tags are all None and only the
/// duration is missing. `has_embedded_cover` is always set here (Some) - any file lofty opens,
/// tags or not, and any file it cannot, counts as examined, so the row never stays NULL.
pub fn read_tags(path: &Path) -> (RawTags, bool) {
    let art = match read_with_art(path) {
        Ok(a) => a,
        Err(_) => {
            return (
                RawTags {
                    has_embedded_cover: Some(false),
                    ..RawTags::default()
                },
                true,
            )
        }
    };

    let tagged = art.tagged();
    let mut raw = RawTags {
        duration_secs: Some(tagged.properties().duration().as_secs_f64()),
        has_embedded_cover: Some(false),
        ..RawTags::default()
    };

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        raw.title = tag.title().map(|c| c.into_owned());
        raw.artist = tag.artist().map(|c| c.into_owned());
        raw.album = tag.album().map(|c| c.into_owned());
        raw.genre = tag.genre().map(|c| c.into_owned());
        raw.album_artist = tag.get_string(ItemKey::AlbumArtist).map(str::to_string);
        raw.track_no = tag.get_string(ItemKey::TrackNumber).map(str::to_string);
        raw.disc_no = tag.get_string(ItemKey::DiscNumber).map(str::to_string);
        raw.year = tag
            .get_string(ItemKey::Year)
            .or_else(|| tag.get_string(ItemKey::RecordingDate))
            .map(str::to_string);
    }

    // Rides the file already read, so it costs no extra read.
    raw.has_embedded_cover = Some(art.cover().is_some());

    (raw, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::covers::test_support::{png_bytes, png_picture, write_mp4_with_pictures};

    #[test]
    fn an_mp4_cover_reads_as_embedded() {
        let path = std::env::temp_dir().join(format!("plisto_scan_tags_{}.m4a", std::process::id()));
        write_mp4_with_pictures(&path, vec![png_picture(png_bytes(8, 8))]);

        let (raw, errored) = read_tags(&path);
        let _ = std::fs::remove_file(&path);

        assert!(!errored);
        assert_eq!(raw.has_embedded_cover, Some(true));
    }
}
