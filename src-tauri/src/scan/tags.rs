/*
 * Reading one file's tags with lofty. Numeric tags (track, disc, year) are pulled as their
 * raw strings, not lofty's parsed integers, so the single numeric-parsing boundary stays in
 * normalize.rs. A file lofty cannot open is not dropped: it yields default (all-None) tags and
 * an error flag, so the caller still indexes it from its path and stats and counts it.
 */

// -- Library Imports --
use std::path::Path;

use lofty::picture::PictureType;
use lofty::prelude::{Accessor, AudioFile, ItemKey, TaggedFileExt};

// -- Type Imports --
use crate::model::RawTags;

/// Reads the primary tag and duration from one file. Returns the tags plus a flag that is true
/// when lofty could not parse the file, in which case the tags are all None and only the
/// duration is missing. `has_embedded_cover` is always set here (Some) - any file lofty opens,
/// tags or not, and any file it cannot, counts as examined, so the row never stays NULL.
pub fn read_tags(path: &Path) -> (RawTags, bool) {
    let tagged = match lofty::read_from_path(path) {
        Ok(t) => t,
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

        // Prefer a front-cover frame, fall back to any picture. This rides the tag lofty
        // already holds, so it costs no extra read.
        let pictures = tag.pictures();
        raw.has_embedded_cover = Some(
            pictures
                .iter()
                .any(|p| p.pic_type() == PictureType::CoverFront)
                || !pictures.is_empty(),
        );
    }

    (raw, false)
}
