/*
 * A stream's text: what the plugin supplies is cleaned here before anything stores or shows it, and
 * `display_pair` is the one place the two now-playing lines are computed. Pure.
 *
 * Cleaning drops every control character (a tab or a line break first becomes a space) and the
 * direction overrides, embeddings, isolates and marks that could reorder what is shown around the
 * text, folds runs of whitespace into one space and trims. Lengths count characters after cleaning.
 */

// -- Local Imports --
use crate::plugins::api::error::ApiError;

/// The most characters a cleaned text field may hold.
pub const TEXT_MAX_CHARS: usize = 200;

/// The plugin's text for one item, cleaned. `now` is set only on a live item.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Meta {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub now: Option<String>,
}

fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}'
    )
}

/// `raw` with controls and direction marks removed and whitespace folded and trimmed.
pub fn clean(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut gap = false;
    for c in raw.chars() {
        let c = match c {
            '\t' | '\n' => ' ',
            c if c.is_control() || is_bidi_control(c) => continue,
            c => c,
        };
        if c.is_whitespace() {
            gap = !out.is_empty();
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
    }
    out
}

/// A required text: 1 to `TEXT_MAX_CHARS` characters once cleaned.
pub fn required(raw: &str, refused: &'static str) -> Result<String, ApiError> {
    let text = clean(raw);
    match text.chars().count() {
        1..=TEXT_MAX_CHARS => Ok(text),
        _ => Err(ApiError::invalid_args(refused)),
    }
}

/// An optional text: at most `TEXT_MAX_CHARS` characters once cleaned; empty reads as absent.
pub fn optional(raw: &str, refused: &'static str) -> Result<Option<String>, ApiError> {
    let text = clean(raw);
    if text.chars().count() > TEXT_MAX_CHARS {
        return Err(ApiError::invalid_args(refused));
    }
    Ok((!text.is_empty()).then_some(text))
}

/// The two lines the stash, the media keys card and the widget show: the live line over the title
/// when the plugin set one, else the title over the artist.
pub fn display_pair(meta: &Meta) -> (String, Option<String>) {
    match &meta.now {
        Some(now) => (now.clone(), Some(meta.title.clone())),
        None => (meta.title.clone(), meta.artist.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;

    #[test]
    fn title_rules_and_sanitizing_table() {
        let long = "a".repeat(TEXT_MAX_CHARS);
        let too_long = "a".repeat(TEXT_MAX_CHARS + 1);
        // Characters count, not bytes: 200 two-byte letters fit.
        let wide = "\u{e9}".repeat(TEXT_MAX_CHARS);
        let cases: [(&str, Option<&str>); 11] = [
            ("Radio One", Some("Radio One")),
            ("  Radio \t\n One  ", Some("Radio One")),
            ("Radio\r\nOne", Some("Radio One")),
            ("Ra\u{0}d\u{7}io\u{7f}\u{85}", Some("Radio")),
            ("\u{3000}Wide\u{2003}space\u{3000}", Some("Wide space")),
            ("", None),
            ("   \t\n", None),
            ("\u{202E}\u{200F}", None),
            (&long, Some(&long)),
            (&too_long, None),
            (&wide, Some(&wide)),
        ];
        for (raw, want) in cases {
            let got = required(raw, "bad title");
            match want {
                Some(text) => assert_eq!(got.as_deref(), Ok(text), "{raw:?}"),
                None => assert_eq!(got.unwrap_err().code, ApiCode::InvalidArgs, "{raw:?}"),
            }
        }
        // Optional fields take empty as absent and refuse only the length.
        assert_eq!(optional("  ", "bad"), Ok(None));
        assert_eq!(optional(" Band ", "bad"), Ok(Some("Band".into())));
        assert!(optional(&too_long, "bad").is_err());
        // Padding around a full-length title is trimmed before the count.
        let padded = format!("  {long}  ");
        assert_eq!(required(&padded, "bad").as_deref(), Ok(long.as_str()));
    }

    #[test]
    fn bidi_and_controls_are_removed() {
        let raw =
            "\u{202A}a\u{202B}b\u{202C}c\u{202D}d\u{202E}e\u{2066}f\u{2067}g\u{2068}h\u{2069}\
                   i\u{200E}j\u{200F}k\u{061C}l\u{1b}[31mm\u{9b}n";
        assert_eq!(clean(raw), "abcdefghijkl[31mmn");
        let cleaned = clean("x\u{202E}gpj.exe");
        assert!(cleaned
            .chars()
            .all(|c| !is_bidi_control(c) && !c.is_control()));
        // Letters and marks of every script stay.
        assert_eq!(
            clean("\u{5e9}\u{5dc}\u{5d5}\u{5dd} caf\u{e9}"),
            "\u{5e9}\u{5dc}\u{5d5}\u{5dd} caf\u{e9}"
        );
    }

    #[test]
    fn the_display_pair_puts_the_live_line_over_the_title() {
        let mut meta = Meta {
            title: "Station".into(),
            artist: Some("Host".into()),
            album: Some("Album".into()),
            now: None,
        };
        assert_eq!(display_pair(&meta), ("Station".into(), Some("Host".into())));
        meta.now = Some("Song - Band".into());
        assert_eq!(
            display_pair(&meta),
            ("Song - Band".into(), Some("Station".into()))
        );
        meta.now = None;
        meta.artist = None;
        assert_eq!(display_pair(&meta), ("Station".into(), None));
    }
}
