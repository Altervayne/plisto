/*
 * The override resolver: the single choke point where a track's editable value is derived from
 * its immutable source cache and an optional user override. An override always wins; absent one,
 * the raw value stands; with neither, the value is unset. The album fields add one layer: the album
 * or single a track is filed into, resolved as the track grids show them. This is pure and
 * deterministic so every read path computes the effective value the same way, and the raw source
 * cache is never overwritten.
 */

/// The effective title: the override when set, else the raw source title, else None.
#[allow(dead_code)]
pub fn effective_title(
    raw_title: &Option<String>,
    title_override: &Option<String>,
) -> Option<String> {
    title_override.clone().or_else(|| raw_title.clone())
}

/// The effective artist: the override when set, else the raw source artist, else None.
#[allow(dead_code)]
pub fn effective_artist(
    raw_artist: &Option<String>,
    artist_override: &Option<String>,
) -> Option<String> {
    artist_override.clone().or_else(|| raw_artist.clone())
}

/// A track's album, album artist and year, as one layer of its resolution.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AlbumFields {
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
}

/// What a track is filed into, with that container's own fields.
#[derive(Debug, Clone, Copy)]
pub enum Filing<'a> {
    Album(&'a AlbumFields),
    Single(&'a AlbumFields),
    Loose,
}

/// A track's effective album fields, as Plisto shows them. An album member takes its album's
/// title, album artist and year outright: a member has no per-track album fields, so any edit is a
/// stale leftover. A single's track takes each edit over the single's field. A loose track takes each
/// edit over its raw tag. A filed track never falls back to its raw tags, and an empty text reads as
/// unset.
pub fn effective_album_fields(
    edit: &AlbumFields,
    raw: &AlbumFields,
    filing: Filing<'_>,
) -> AlbumFields {
    let resolved = match filing {
        Filing::Album(album) => album.clone(),
        Filing::Single(base) => over(edit, base),
        Filing::Loose => over(edit, raw),
    };
    let text = |v: Option<String>| v.filter(|s| !s.is_empty());
    AlbumFields {
        album: text(resolved.album),
        album_artist: text(resolved.album_artist),
        year: resolved.year,
    }
}

/// Each field of `edit`, else the same field of `base`.
fn over(edit: &AlbumFields, base: &AlbumFields) -> AlbumFields {
    AlbumFields {
        album: edit.album.clone().or_else(|| base.album.clone()),
        album_artist: edit
            .album_artist
            .clone()
            .or_else(|| base.album_artist.clone()),
        year: edit.year.or(base.year),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(album: Option<&str>, album_artist: Option<&str>, year: Option<i64>) -> AlbumFields {
        AlbumFields {
            album: album.map(str::to_string),
            album_artist: album_artist.map(str::to_string),
            year,
        }
    }

    const NONE: (Option<&str>, Option<&str>, Option<i64>) = (None, None, None);

    #[test]
    fn album_fields_follow_the_display_rule() {
        type Row<'a> = (
            &'a str,
            &'a str,
            (Option<&'a str>, Option<&'a str>, Option<i64>),
            (Option<&'a str>, Option<&'a str>, Option<i64>),
            Option<(Option<&'a str>, Option<&'a str>, Option<i64>)>,
            (Option<&'a str>, Option<&'a str>, Option<i64>),
        );
        let blue = (Some("Kind of Blue"), Some("Miles Davis"), Some(1959));
        let cut = (Some("One Cut"), Some("Miles Davis"), Some(1959));
        let stale = (Some("Stale tag"), Some("Stale"), Some(1900));
        // (case, kind, edit, raw, container, expected)
        let cases: [Row; 11] = [
            (
                "album member ignores its stale raw tags",
                "album",
                NONE,
                stale,
                Some(blue),
                blue,
            ),
            (
                "album member ignores a per-track edit",
                "album",
                (Some("Renamed"), Some("Sextet"), Some(1997)),
                stale,
                Some(blue),
                blue,
            ),
            (
                "untitled, yearless album member folds to empty",
                "album",
                NONE,
                stale,
                Some((None, None, None)),
                NONE,
            ),
            (
                "album member with an empty title reads unset",
                "album",
                NONE,
                stale,
                Some((Some(""), Some(""), Some(1959))),
                (None, None, Some(1959)),
            ),
            (
                "single member inherits its single",
                "single",
                NONE,
                stale,
                Some(cut),
                cut,
            ),
            (
                "single member's album edit wins",
                "single",
                (Some("Renamed"), None, None),
                stale,
                Some(cut),
                (Some("Renamed"), Some("Miles Davis"), Some(1959)),
            ),
            (
                "single member's album artist edit wins",
                "single",
                (None, Some("Sextet"), None),
                NONE,
                Some(cut),
                (Some("One Cut"), Some("Sextet"), Some(1959)),
            ),
            (
                "single member's year edit wins",
                "single",
                (None, None, Some(1997)),
                NONE,
                Some(cut),
                (Some("One Cut"), Some("Miles Davis"), Some(1997)),
            ),
            (
                "loose track reads its raw tags",
                "loose",
                NONE,
                (Some("Aja"), Some("VA"), Some(1971)),
                None,
                (Some("Aja"), Some("VA"), Some(1971)),
            ),
            (
                "loose track's edits win over raw",
                "loose",
                (Some("Gaucho"), None, Some(1980)),
                (Some("Aja"), Some("VA"), Some(1971)),
                None,
                (Some("Gaucho"), Some("VA"), Some(1980)),
            ),
            (
                "loose track with nothing is unset",
                "loose",
                NONE,
                NONE,
                None,
                NONE,
            ),
        ];
        for (case, kind, edit, raw, container, expected) in cases {
            let edit = fields(edit.0, edit.1, edit.2);
            let raw = fields(raw.0, raw.1, raw.2);
            let container = container.map(|c| fields(c.0, c.1, c.2));
            let filing = match (kind, container.as_ref()) {
                ("album", Some(c)) => Filing::Album(c),
                ("single", Some(c)) => Filing::Single(c),
                _ => Filing::Loose,
            };
            let got = effective_album_fields(&edit, &raw, filing);
            assert_eq!(got, fields(expected.0, expected.1, expected.2), "{case}");
        }
    }

    #[test]
    fn override_wins_over_raw() {
        assert_eq!(
            effective_title(&Some("raw".into()), &Some("edited".into())),
            Some("edited".into()),
        );
        assert_eq!(
            effective_artist(&Some("raw".into()), &Some("edited".into())),
            Some("edited".into()),
        );
    }

    #[test]
    fn raw_stands_without_an_override() {
        assert_eq!(
            effective_title(&Some("raw".into()), &None),
            Some("raw".into()),
        );
        assert_eq!(
            effective_artist(&Some("raw".into()), &None),
            Some("raw".into()),
        );
    }

    #[test]
    fn neither_resolves_to_none() {
        assert_eq!(effective_title(&None, &None), None);
        assert_eq!(effective_artist(&None, &None), None);
    }
}
