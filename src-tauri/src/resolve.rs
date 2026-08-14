/*
 * The override resolver: the single choke point where a track's editable value is derived from
 * its immutable source cache and an optional user override. An override always wins; absent one,
 * the raw value stands; with neither, the value is unset. This is pure and deterministic so the
 * read path and the export path compute the effective value the exact same way, and the raw
 * source cache is never overwritten.
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

#[cfg(test)]
mod tests {
    use super::*;

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
