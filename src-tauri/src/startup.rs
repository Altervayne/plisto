/*
 * Launch-argv parsing for OS file delivery. The OS hands Plisto the file it was asked to open as a
 * process argument, on a cold launch through the initial argv and on a warm one through the single-
 * instance callback's argv. Both go through here to pull the audio paths out and drop the exe and any
 * flags, so a launch that carries no file (a bare relaunch) is told apart from one that opens a track.
 */

// -- Library Imports --
use std::path::Path;

// The extensions Plisto registers as a file-association handler for, so the OS only ever delivers one
// of these. Kept in step with bundle.fileAssociations in tauri.conf.json. Lowercase; matched case-
// insensitively.
const PLAYABLE_EXTS: &[&str] = &["mp3", "flac", "wav", "m4a", "m4b", "ogg", "oga", "opus"];

/// The audio file paths carried in a launch or relaunch argv: every arg past the exe that is not a
/// flag and carries a playable extension. A bare relaunch yields an empty vec, so the caller can tell
/// "open this file" from "just surface the window". Pure over its input, so the filter is testable
/// without a real launch.
pub fn audio_paths_from_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| has_playable_ext(arg))
        .cloned()
        .collect()
}

/// True when `arg`'s extension is one Plisto registered to open, folded to lowercase.
fn has_playable_ext(arg: &str) -> bool {
    Path::new(arg)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| PLAYABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn keeps_the_audio_path_and_drops_the_exe() {
        let paths = audio_paths_from_argv(&argv(&["plisto.exe", "C:\\music\\song.mp3"]));
        assert_eq!(paths, vec!["C:\\music\\song.mp3".to_string()]);
    }

    #[test]
    fn drops_flags_and_non_audio_args() {
        let paths = audio_paths_from_argv(&argv(&[
            "plisto.exe",
            "--flag",
            "notes.txt",
            "C:\\music\\a.flac",
        ]));
        assert_eq!(paths, vec!["C:\\music\\a.flac".to_string()]);
    }

    #[test]
    fn a_bare_relaunch_yields_no_files() {
        assert!(audio_paths_from_argv(&argv(&["plisto.exe"])).is_empty());
    }

    #[test]
    fn matches_the_extension_case_insensitively() {
        let paths = audio_paths_from_argv(&argv(&["plisto.exe", "C:\\music\\Track.OPUS"]));
        assert_eq!(paths, vec!["C:\\music\\Track.OPUS".to_string()]);
    }

    #[test]
    fn keeps_every_delivered_audio_file() {
        let paths = audio_paths_from_argv(&argv(&[
            "plisto.exe",
            "one.mp3",
            "two.m4b",
            "three.oga",
        ]));
        assert_eq!(paths, vec!["one.mp3", "two.m4b", "three.oga"]);
    }
}
