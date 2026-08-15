/*
 * The filename inverse of the derivation grammar: pure, deterministic, no disk and no clock. It
 * turns an export pattern and a path back into the fields that would have produced them, so a
 * library organized elsewhere can be read into the edit layer. The pattern compiles once into a
 * regex - numeric tokens become digit groups, free-text tokens lazy groups anchored by the trailing
 * `$`, a `*` a within-segment wildcard - and each path matches a suffix of that regex, its extension
 * stripped first the way the deriver appends one. Mirrors substitute at derive.rs: the same nine
 * tokens, the same unknown-token-stays-literal rule, walked in the same shape but emitting a matcher
 * instead of text.
 */

// -- Library Imports --
use regex::Regex;

/// The fields recovered from one path. Every field is optional: a token absent from the pattern
/// leaves its field null, and a numeric token whose text will not parse falls to null too. Numeric
/// fields are parsed to `i64`; free-text fields are trimmed of surrounding whitespace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedFields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub disc_no: Option<i64>,
    pub track_no: Option<i64>,
    pub genre: Option<String>,
}

/// A pattern compiled to its matcher. `strip_ext` is true unless the pattern spelled `{ext}` itself,
/// in which case the pattern owns the extension and the path keeps it for the match.
#[derive(Debug, Clone)]
pub struct CompiledPattern {
    regex: Regex,
    strip_ext: bool,
}

/// Compiles a pattern into its matcher once, to reuse across a whole batch of paths. Walks the
/// pattern like `substitute`: separators normalize to `/`, the nine tokens become regex fragments,
/// an unknown `{name}` and an unclosed `{` stay literal, a `*` becomes a within-segment wildcard,
/// and every literal run is escaped. The body is wrapped `(?i)(?:^|.*/)...$` so a match ignores any
/// unspecified leading folders and is case-insensitive. Returns None when the emitted regex is
/// malformed - most often a token repeated, which would need two captures of one name.
pub fn compile(pattern: &str) -> Option<CompiledPattern> {
    let normalized = pattern.replace('\\', "/");
    let mut body = String::new();
    let mut has_ext = false;
    let mut rest = normalized.as_str();

    while let Some(open) = rest.find('{') {
        push_literal(&mut body, &rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                if is_numeric(name) {
                    body.push_str(&format!("(?P<{name}>\\d+)"));
                } else if is_text(name) {
                    // A field value never carries a path separator - `/` is always a folder boundary,
                    // never part of a name - so a free-text token matches within its own segment. That
                    // is what lets the leading-path prefix strip whole folders the pattern did not name.
                    body.push_str(&format!("(?P<{name}>[^/]+?)"));
                } else if name == "ext" {
                    // The pattern places the extension; match it without capturing a field.
                    body.push_str("[^.]+");
                    has_ext = true;
                } else {
                    // An unrecognized token stays literal, the way substitute leaves it in place.
                    push_literal(&mut body, &format!("{{{name}}}"));
                }
                rest = &after[close + 1..];
            }
            None => {
                // A stray `{` with no closer: the rest of the pattern is literal.
                push_literal(&mut body, &rest[open..]);
                rest = "";
            }
        }
    }
    push_literal(&mut body, rest);

    let full = format!("(?i)(?:^|.*/){body}$");
    let regex = Regex::new(&full).ok()?;
    Some(CompiledPattern {
        regex,
        strip_ext: !has_ext,
    })
}

/// Recovers the fields from one path, or None when the path does not match the pattern. The path's
/// separators normalize to `/` and its extension is stripped first, unless the pattern owns the
/// extension itself.
pub fn parse(compiled: &CompiledPattern, path: &str) -> Option<ParsedFields> {
    let normalized = path.replace('\\', "/");
    let target = if compiled.strip_ext {
        strip_extension(&normalized)
    } else {
        normalized
    };

    let caps = compiled.regex.captures(&target)?;
    Some(ParsedFields {
        title: text_field(&caps, "title"),
        artist: text_field(&caps, "artist"),
        album: text_field(&caps, "album"),
        album_artist: text_field(&caps, "albumartist"),
        year: num_field(&caps, "year"),
        disc_no: num_field(&caps, "disc"),
        track_no: num_field(&caps, "track_no"),
        genre: text_field(&caps, "genre"),
    })
}

/// The three tokens whose value is a run of digits.
fn is_numeric(name: &str) -> bool {
    matches!(name, "track_no" | "year" | "disc")
}

/// The five tokens whose value is free text.
fn is_text(name: &str) -> bool {
    matches!(name, "title" | "artist" | "album" | "albumartist" | "genre")
}

/// Appends a literal run to the body, escaping it for the regex. A `*` inside the run is the one
/// exception: it becomes a within-segment wildcard that skips a folder or part without crossing `/`.
fn push_literal(out: &mut String, lit: &str) {
    let mut buf = String::new();
    for ch in lit.chars() {
        if ch == '*' {
            if !buf.is_empty() {
                out.push_str(&regex::escape(&buf));
                buf.clear();
            }
            out.push_str("[^/]*");
        } else {
            buf.push(ch);
        }
    }
    if !buf.is_empty() {
        out.push_str(&regex::escape(&buf));
    }
}

/// A captured free-text field, trimmed. None when the group was absent from the pattern.
fn text_field(caps: &regex::Captures, name: &str) -> Option<String> {
    caps.name(name).map(|m| m.as_str().trim().to_string())
}

/// A captured numeric field parsed to `i64`. None when the group was absent or its digits overflow.
fn num_field(caps: &regex::Captures, name: &str) -> Option<i64> {
    caps.name(name).and_then(|m| m.as_str().parse().ok())
}

/// The path with the final segment's extension removed - everything after the last `.` in the last
/// path component. A leading-dot component (a name with no stem) keeps its whole name; a component
/// with no dot is unchanged.
fn strip_extension(path: &str) -> String {
    let seg_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let segment = &path[seg_start..];
    match segment.rfind('.') {
        Some(dot) if dot > 0 => path[..seg_start + dot].to_string(),
        _ => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compiles then parses in one step, for the many single-path cases below.
    fn run(pattern: &str, path: &str) -> Option<ParsedFields> {
        parse(&compile(pattern).unwrap(), path)
    }

    #[test]
    fn full_filename_pattern_recovers_every_field() {
        let f = run("{track_no} - {artist} - {title}", "03 - Radiohead - Nude").unwrap();
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.artist.as_deref(), Some("Radiohead"));
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn leading_path_is_ignored_and_the_extension_stripped() {
        // The pattern names an album folder and a filename; the drive and intermediate folders above
        // it need not be spelled, and the `.flac` comes off before matching.
        let f = run(
            "{album}/{track_no} - {title}",
            "F:/x/y/In Rainbows/03 - Nude.flac",
        )
        .unwrap();
        assert_eq!(f.album.as_deref(), Some("In Rainbows"));
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn wildcard_skips_a_disc_folder() {
        let f = run("{album}/*/{track_no} - {title}", "In Rainbows/CD1/03 - Nude").unwrap();
        assert_eq!(f.album.as_deref(), Some("In Rainbows"));
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn backslash_paths_normalize_to_forward_slashes() {
        let f = run("{album}/*/{track_no} - {title}", "In Rainbows\\CD1\\03 - Nude.flac").unwrap();
        assert_eq!(f.album.as_deref(), Some("In Rainbows"));
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn the_final_free_text_token_takes_the_whole_tail() {
        // The end anchor forces the last lazy group to expand across the separators inside the title.
        let f = run("{track_no} - {title}", "03 - A - B - C").unwrap();
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.title.as_deref(), Some("A - B - C"));
    }

    #[test]
    fn a_path_that_does_not_match_returns_none() {
        assert!(run("{track_no} - {title}", "no number here").is_none());
    }

    #[test]
    fn a_numeric_token_parses_to_an_integer() {
        let f = run("{year} - {album}", "2007 - In Rainbows").unwrap();
        assert_eq!(f.year, Some(2007));
        assert_eq!(f.album.as_deref(), Some("In Rainbows"));
    }

    #[test]
    fn matching_is_case_insensitive_across_literals() {
        let f = run("Disc {disc} - {title}", "disc 1 - Nude").unwrap();
        assert_eq!(f.disc_no, Some(1));
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn an_unknown_token_stays_literal() {
        // `{unknown}` is not one of the nine, so it matches itself rather than capturing a field.
        let f = run("{track_no} - {unknown} - {title}", "03 - {unknown} - Nude").unwrap();
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.title.as_deref(), Some("Nude"));
        // A path missing the literal cannot match.
        assert!(run("{track_no} - {unknown} - {title}", "03 - x - Nude").is_none());
    }

    #[test]
    fn an_unclosed_brace_is_literal_to_the_end() {
        let f = run("{track_no} - {title", "03 - {title").unwrap();
        assert_eq!(f.track_no, Some(3));
        // The `{title` never became a token, so no title was captured.
        assert_eq!(f.title, None);
    }

    #[test]
    fn a_field_whose_token_is_absent_stays_none() {
        // Only track_no and title appear; every other field is left null.
        let f = run("{track_no} - {title}", "03 - Nude").unwrap();
        assert_eq!(f.track_no, Some(3));
        assert_eq!(f.title.as_deref(), Some("Nude"));
        assert_eq!(f.artist, None);
        assert_eq!(f.album, None);
        assert_eq!(f.album_artist, None);
        assert_eq!(f.year, None);
        assert_eq!(f.disc_no, None);
        assert_eq!(f.genre, None);
    }

    #[test]
    fn an_ext_token_matches_the_extension_without_capturing_it() {
        // With `{ext}` present the path keeps its extension, and the token consumes it as no field.
        let f = run("{title}.{ext}", "Nude.flac").unwrap();
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn a_repeated_token_is_rejected_as_malformed() {
        // Two captures of one name cannot compile; the inverse is ambiguous, so compile declines.
        assert!(compile("{title} - {title}").is_none());
    }

    #[test]
    fn free_text_values_are_trimmed() {
        let f = run("{track_no} -  {title} ", "03 -  Nude ").unwrap();
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }

    #[test]
    fn a_dotless_final_segment_is_not_truncated() {
        // The last component carries no extension, so nothing is stripped before matching.
        let f = run("{album}/{title}", "In Rainbows/Nude").unwrap();
        assert_eq!(f.album.as_deref(), Some("In Rainbows"));
        assert_eq!(f.title.as_deref(), Some("Nude"));
    }
}
