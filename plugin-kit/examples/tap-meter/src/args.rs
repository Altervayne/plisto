/*
 * What tap-meter is told at start. Plisto passes `--plisto-protocol`, `--plisto-data` and
 * `--plisto-tap` on the command line. The manifest has no field for extra arguments, so the test flags
 * (`--crash-after`, `--stall`, `--takeover`, `--prompt-unprompted`) are read from a `tap-meter.flags`
 * text file beside the executable; the same flags are also accepted on the command line, for running it
 * by hand.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::time::Duration;

/// The name of the flags file, looked up beside the executable.
pub const FLAGS_FILE: &str = "tap-meter.flags";

#[derive(Debug, Default, PartialEq)]
pub struct Config {
    pub protocol: Option<u32>,
    pub data: Option<PathBuf>,
    /// The tap mapping's name; None when Plisto passed `none`.
    pub tap: Option<String>,
    /// Exit abruptly this long after `ready`.
    pub crash_after: Option<Duration>,
    /// Stop answering pings and page calls for this long, starting at the second ping.
    pub stall: Option<Duration>,
    /// Ask Plisto to hold its local output after `ready`.
    pub takeover: bool,
    /// Ask for a prompt with no gesture once the page is closed, to show the refusal.
    pub prompt_unprompted: bool,
    /// Arguments that were not understood, one line each.
    pub warnings: Vec<String>,
}

// Plain seconds, with an optional trailing `s`: `2`, `2s`, `0.5`.
fn seconds(text: &str) -> Option<Duration> {
    let n: f64 = text.strip_suffix('s').unwrap_or(text).parse().ok()?;
    (n.is_finite() && (0.0..=86_400.0).contains(&n)).then(|| Duration::from_secs_f64(n))
}

/// Parses flag tokens. Unknown or malformed ones become warnings, never errors.
pub fn parse(tokens: impl IntoIterator<Item = String>) -> Config {
    let mut config = Config::default();
    let mut tokens = tokens.into_iter();
    while let Some(flag) = tokens.next() {
        match flag.as_str() {
            "--takeover" => config.takeover = true,
            "--prompt-unprompted" => config.prompt_unprompted = true,
            "--plisto-protocol" | "--plisto-data" | "--plisto-tap" | "--crash-after"
            | "--stall" => {
                let Some(value) = tokens.next() else {
                    config.warnings.push(format!("{flag} needs a value"));
                    break;
                };
                let ok = match flag.as_str() {
                    "--plisto-protocol" => value.parse().map(|v| config.protocol = Some(v)).is_ok(),
                    "--plisto-data" => {
                        config.data = Some(PathBuf::from(&value));
                        true
                    }
                    "--plisto-tap" => {
                        config.tap = (value != "none").then(|| value.clone());
                        true
                    }
                    "--crash-after" => seconds(&value)
                        .map(|d| config.crash_after = Some(d))
                        .is_some(),
                    _ => seconds(&value).map(|d| config.stall = Some(d)).is_some(),
                };
                if !ok {
                    config.warnings.push(format!("{flag}: bad value '{value}'"));
                }
            }
            other => config.warnings.push(format!("unknown argument '{other}'")),
        }
    }
    config
}

/// The tokens of a flags file: whitespace separated, `#` starts a comment that runs to the line end.
pub fn flag_tokens(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.split('#').next().unwrap_or(""))
        .flat_map(str::split_whitespace)
        .map(str::to_string)
        .collect()
}

/// The command line, then the flags file beside the executable if there is one. Later flags win.
pub fn load() -> Config {
    let mut tokens: Vec<String> = std::env::args().skip(1).collect();
    let file = std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::read_to_string(exe.with_file_name(FLAGS_FILE)).ok());
    if let Some(text) = file {
        tokens.extend(flag_tokens(&text));
    }
    parse(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn the_arguments_plisto_passes_are_read() {
        let c = parse(tokens(
            r"--plisto-protocol 1 --plisto-data C:\data --plisto-tap Local\plisto-tap-1-2",
        ));
        assert_eq!(c.protocol, Some(1));
        assert_eq!(c.data, Some(PathBuf::from(r"C:\data")));
        assert_eq!(c.tap.as_deref(), Some(r"Local\plisto-tap-1-2"));
        assert!(c.warnings.is_empty());
        assert_eq!(parse(tokens("--plisto-tap none")).tap, None);
    }

    #[test]
    fn the_test_flags_are_read() {
        let c = parse(tokens(
            "--crash-after 2s --stall 5 --takeover --prompt-unprompted",
        ));
        assert_eq!(c.crash_after, Some(Duration::from_secs(2)));
        assert_eq!(c.stall, Some(Duration::from_secs(5)));
        assert!(c.takeover);
        assert!(c.prompt_unprompted);
        assert!(c.warnings.is_empty());
    }

    #[test]
    fn bad_input_warns_and_goes_on() {
        let c = parse(tokens("--stall soon --nope --takeover --crash-after"));
        assert_eq!(c.stall, None);
        assert!(c.takeover);
        assert_eq!(c.warnings.len(), 3);
    }

    #[test]
    fn a_flags_file_allows_comments_and_lines() {
        let text = "# test run\n--stall 5   # five seconds\n\n--takeover\n";
        assert_eq!(flag_tokens(text), tokens("--stall 5 --takeover"));
    }
}
