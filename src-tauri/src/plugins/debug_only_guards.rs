/*
 * Source guards for development-only code. In the files that declare modules and register commands,
 * every code line naming a probe item must be gated on `debug_assertions` and hold one statement:
 * gated by an attribute at the start of the same line, or by one alone on the line before. Across the
 * whole crate, every module declared as `probe` or `probes` must carry a gate that keeps it out of a
 * release build: `debug_assertions`, or `test` for a test-only module.
 *
 * The scan reads code only: comments are dropped and string contents blanked, so a probe named in a
 * string is not checked. It does not catch a development module under another name, or a reference
 * to one from a file outside the wiring list; a release compile catches the latter, since the gated
 * item is then absent.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};

// The files that wire modules and commands into the app, relative to the crate root.
const WIRING: &[&str] = &[
    "src/lib.rs",
    "src/commands/mod.rs",
    "src/plugins/mod.rs",
    "src/plugins/frame_host.rs",
    "src/plugins/frame_host_win.rs",
];

const CFG_OPEN: &str = "#[cfg(";
const DEBUG: &str = "debug_assertions";

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Each line's code, trimmed, with comments removed and string contents blanked. Block comments
/// and strings carry across lines.
fn code_lines(source: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut block = 0usize;
    let mut in_str = false;
    for line in source.lines() {
        let chars: Vec<char> = line.chars().collect();
        let mut code = String::new();
        let mut i = 0;
        while i < chars.len() {
            let (c, next) = (chars[i], chars.get(i + 1).copied());
            if block > 0 {
                if c == '*' && next == Some('/') {
                    block -= 1;
                    i += 2;
                } else if c == '/' && next == Some('*') {
                    block += 1;
                    i += 2;
                } else {
                    i += 1;
                }
            } else if in_str {
                if c == '\\' {
                    i += 2;
                    continue;
                }
                if c == '"' {
                    in_str = false;
                    code.push(c);
                }
                i += 1;
            } else if c == '/' && next == Some('/') {
                break;
            } else if c == '/' && next == Some('*') {
                block = 1;
                i += 2;
            } else if c == '"' {
                in_str = true;
                code.push(c);
                i += 1;
            } else if c == '\'' && next == Some('\\') {
                // An escaped char literal: skip to its closing quote.
                i += 2;
                while i < chars.len() && chars[i] != '\'' {
                    i += 1;
                }
                i += 1;
            } else if c == '\'' && chars.get(i + 2) == Some(&'\'') {
                i += 3;
            } else {
                code.push(c);
                i += 1;
            }
        }
        lines.push(code.trim().to_string());
    }
    lines
}

/// Whether code names `probe` or `probes` as a word, in any case. Underscores split words, so
/// `probe_capture` counts.
fn names_probe(code: &str) -> bool {
    code.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word.eq_ignore_ascii_case("probe") || word.eq_ignore_ascii_case("probes"))
}

/// The predicate of a `#[cfg(...)]` at the start of `code`, and the code after it.
fn leading_cfg(code: &str) -> Option<(&str, &str)> {
    let rest = code.strip_prefix(CFG_OPEN)?;
    let mut depth = 1;
    for (i, c) in rest.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let after = rest[i + 1..].strip_prefix(']')?;
                    return Some((&rest[..i], after.trim()));
                }
            }
            _ => {}
        }
    }
    None
}

/// The comma-separated terms at the top level of a predicate list.
fn top_level_terms(list: &str) -> Vec<&str> {
    let mut terms = Vec::new();
    let (mut depth, mut start) = (0, 0);
    for (i, c) in list.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                terms.push(list[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    terms.push(list[start..].trim());
    terms
}

/// Whether a predicate holds only with `debug_assertions` on: the flag itself, or an `all(...)`
/// with the flag as one of its own terms.
fn is_debug_predicate(predicate: &str) -> bool {
    let predicate = predicate.trim();
    predicate == DEBUG
        || predicate
            .strip_prefix("all(")
            .and_then(|inner| inner.strip_suffix(')'))
            .is_some_and(|inner| top_level_terms(inner).contains(&DEBUG))
}

fn is_debug_or_test_predicate(predicate: &str) -> bool {
    is_debug_predicate(predicate) || predicate.trim() == "test"
}

/// Whether code holds at most one statement: no `;` but a final one.
fn one_statement(code: &str) -> bool {
    let code = code.trim();
    !code.strip_suffix(';').unwrap_or(code).contains(';')
}

/// Whether line `i` is gated by an accepted predicate and holds one statement.
fn gated(code: &[String], i: usize, accept: fn(&str) -> bool) -> bool {
    if let Some((predicate, rest)) = leading_cfg(&code[i]) {
        return accept(predicate) && one_statement(rest);
    }
    let above = i.checked_sub(1).and_then(|j| leading_cfg(&code[j]));
    one_statement(&code[i])
        && above.is_some_and(|(predicate, rest)| accept(predicate) && rest.is_empty())
}

/// The 1-based numbers of code lines naming a probe item without a debug gate.
fn ungated_probe_lines(source: &str) -> Vec<usize> {
    let code = code_lines(source);
    (0..code.len())
        .filter(|&i| names_probe(&code[i]) && !gated(&code, i, is_debug_predicate))
        .map(|i| i + 1)
        .collect()
}

/// Whether code declares a module named exactly `probe` or `probes`, with any visibility.
fn declares_probe_module(code: &str) -> bool {
    let code = leading_cfg(code).map_or(code, |(_, rest)| rest);
    let Some(decl) = code.strip_suffix(';').or_else(|| code.strip_suffix('{')) else {
        return false;
    };
    let words: Vec<&str> = decl.split_whitespace().collect();
    match words.as_slice() {
        [visibility @ .., "mod", "probe" | "probes"] => {
            visibility.is_empty() || (visibility.len() == 1 && visibility[0].starts_with("pub"))
        }
        _ => false,
    }
}

/// The 1-based numbers of `probe` or `probes` module declarations no gate keeps out of a release
/// build.
fn ungated_probe_modules(source: &str) -> Vec<usize> {
    let code = code_lines(source);
    (0..code.len())
        .filter(|&i| {
            declares_probe_module(&code[i]) && !gated(&code, i, is_debug_or_test_predicate)
        })
        .map(|i| i + 1)
        .collect()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn every_probe_line_in_the_wiring_files_is_debug_only() {
    let mut named = 0;
    for rel in WIRING {
        let source = fs::read_to_string(crate_root().join(rel)).unwrap();
        named += code_lines(&source)
            .iter()
            .filter(|code| names_probe(code))
            .count();
        assert_eq!(
            ungated_probe_lines(&source),
            Vec::<usize>::new(),
            "{rel}: these lines name a probe item without a #[cfg(debug_assertions)] gate, or hold \
             more than one statement under it, so they would compile into a release build"
        );
    }
    assert!(
        named > 0,
        "no wiring file names a probe item, so this guard checks nothing"
    );
}

#[test]
fn every_probe_module_in_the_crate_is_kept_out_of_release() {
    let mut files = Vec::new();
    rust_files(&crate_root().join("src"), &mut files);
    let mut declared = 0;
    for path in &files {
        let source = fs::read_to_string(path).unwrap();
        declared += code_lines(&source)
            .iter()
            .filter(|code| declares_probe_module(code))
            .count();
        assert_eq!(
            ungated_probe_modules(&source),
            Vec::<usize>::new(),
            "{}: a `probe` or `probes` module without a #[cfg(debug_assertions)] or #[cfg(test)] \
             gate on the line above",
            path.display()
        );
    }
    assert!(
        declared > 0,
        "no probe module found, so this guard checks nothing"
    );
}

#[test]
fn the_wiring_rule_rejects_each_bad_sample() {
    let source = "\
#[cfg(debug_assertions)]
mod probe;
#[cfg(all(windows, debug_assertions))] pub mod probes;
// a probe named in a comment
pub mod probes;
#[cfg(test)]
mod probe;
#[cfg(not(debug_assertions))]
mod probe;
#[cfg(any(windows, debug_assertions))]
commands::probes::capture::probe_capture,
#[cfg(debug_assertions)]
let x = 1; probe_capture();
/* dev */ mod probe;
#[cfg(feature = \"debug_assertions\")]
mod probe;
#[cfg(debug_assertions)] mod probe; mod other;
#[cfg(debug_assertions)]

mod probe;
let url = \"https://probe.invalid/\";
/* a probe
   named in a block comment */
#[cfg(all(windows, any(test, debug_assertions)))]
mod probe;
fn unrelated() {}
";
    assert_eq!(
        ungated_probe_lines(source),
        [5, 7, 9, 11, 13, 14, 16, 17, 20, 25]
    );
}

#[test]
fn the_module_rule_rejects_each_bad_sample() {
    let source = "\
#[cfg(debug_assertions)]
pub(crate) mod probe;
#[cfg(test)]
mod probe;
mod probes;
#[cfg(windows)]
pub mod probe;
mod probe_tools;
mod probes {
fn probe() {}
/* x */ pub(super) mod probe;
#[cfg(all(test, windows))]
mod probe;
let s = \"mod probe;\";
";
    assert_eq!(ungated_probe_modules(source), [5, 7, 9, 11, 13]);
}

#[test]
fn the_predicate_and_word_rules() {
    for good in [
        "debug_assertions",
        "all(windows, debug_assertions)",
        " all(debug_assertions) ",
    ] {
        assert!(is_debug_predicate(good), "{good}");
    }
    for bad in [
        "test",
        "not(debug_assertions)",
        "any(windows, debug_assertions)",
        "all(windows, not(debug_assertions))",
        "all(windows, any(test, debug_assertions))",
        "feature = \"debug_assertions\"",
        "debug_assertions_x",
    ] {
        assert!(!is_debug_predicate(bad), "{bad}");
    }
    assert!(names_probe("frame_host::probe::respond"));
    assert!(names_probe("PROBE_FILTER"));
    assert!(!names_probe("probed_versions"));
    assert!(!names_probe("debug_only_guards"));
}
