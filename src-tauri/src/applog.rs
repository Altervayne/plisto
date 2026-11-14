/*
 * Shared plain-text log plumbing: flattening a message to one capped line, and appending a finished
 * line to a file that rotates into a single `.old` beside it. The callers own the file names, the line
 * layout and any locking.
 */

// -- Library Imports --
use std::fs;
use std::io::{self, Write};
use std::path::Path;

// -- Local Imports --
use crate::plugins::install::rename_with_retry;

/// The most bytes one line's text may hold.
pub const MAX_LINE_BYTES: usize = 2048;

/// Characters that would break a line or hide or reorder text when the log is read: every control
/// character, line and paragraph separators, and invisible and bidi formatting characters.
fn unsafe_in_line(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{61c}'
                | '\u{200b}'..='\u{200f}'
                | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{feff}'
        )
}

/// Replaces line breaks, control characters and invisible formatting characters with spaces, then
/// cuts the text to `MAX_LINE_BYTES` at a character boundary. The flag says whether it was cut.
pub fn sanitize(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(text.len().min(MAX_LINE_BYTES));
    for c in text.chars() {
        let c = if unsafe_in_line(c) { ' ' } else { c };
        if out.len() + c.len_utf8() > MAX_LINE_BYTES {
            return (out, true);
        }
        out.push(c);
    }
    (out, false)
}

/// Appends `line` (newline included) to the file at `path`, first moving the file to `old_path` when
/// the line would take it past `rotate_bytes`. An existing `old_path` is replaced.
pub fn append_line(path: &Path, old_path: &Path, line: &str, rotate_bytes: u64) -> io::Result<()> {
    let size = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e),
    };
    if size > 0 && size + line.len() as u64 > rotate_bytes {
        rename_with_retry(path, old_path)?;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c1_controls_and_invisible_formatting_become_spaces() {
        let hidden = [
            '\u{80}', '\u{85}', '\u{9f}', '\u{61c}', '\u{200b}', '\u{200f}', '\u{2028}', '\u{2029}',
            '\u{202a}', '\u{202e}', '\u{2060}', '\u{2064}', '\u{2066}', '\u{2069}', '\u{feff}',
        ];
        for c in hidden {
            assert_eq!(sanitize(&format!("a{c}b")).0, "a b", "{:x}", c as u32);
        }
        // Neighbours of the refused ranges are kept.
        for c in ['\u{a0}', '\u{e9}', '\u{2014}', '\u{2030}', '\u{2065}', '\u{206a}'] {
            assert_eq!(sanitize(&format!("a{c}b")).0, format!("a{c}b"));
        }
    }
}
