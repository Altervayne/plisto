/*
 * The modes `plisto.exe` runs in when it is started as a helper rather than as the app. The mode is
 * read from argv[1] alone, before anything of the app starts, so a helper never builds a window or a
 * tray icon, never opens the database or the single-instance lock, and never loads a plugin.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::io::{self, Read, Write};

// -- Local Imports --
use super::container;

/// The flag that starts the decode helper. Its stdin and stdout are its pipes to the main process.
pub const DECODE_HELPER_FLAG: &str = "--plisto-decode-helper";
/// The flag the uninstaller runs to delete the helper's AppContainer profile.
pub const REMOVE_CONTAINER_FLAG: &str = "--plisto-remove-container";
/// The AppContainer profile the decode helper runs in.
pub const HELPER_PROFILE: &str = "Plisto.DecodeHelper";

/// The first bytes a helper sends, once it runs: the wire codec's `Ready` frame, kind 0x87 with an
/// empty payload.
pub const READY: [u8; 5] = [0x87, 0, 0, 0, 0];

const ECHO_BUFFER: usize = 64 * 1024;
const EXIT_OK: i32 = 0;
const EXIT_FAILED: i32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelperMode {
    /// Sends `Ready`, then writes back every byte it reads until its stdin closes.
    Echo,
    /// Deletes the decode helper's AppContainer profile.
    RemoveContainer,
}

/// The helper mode argv[1] names, if any.
pub fn mode_from_args(args: impl IntoIterator<Item = OsString>) -> Option<HelperMode> {
    let flag = args.into_iter().nth(1)?;
    if flag == DECODE_HELPER_FLAG {
        Some(HelperMode::Echo)
    } else if flag == REMOVE_CONTAINER_FLAG {
        Some(HelperMode::RemoveContainer)
    } else {
        None
    }
}

/// Runs `mode` to its end and returns the exit code.
pub fn run(mode: HelperMode) -> i32 {
    match mode {
        HelperMode::Echo => {
            #[cfg(debug_assertions)]
            if let Some(id) = super::probe::app_id_from_args(std::env::args_os()) {
                let _ = super::probe::set_app_id(&id);
            }
            // A pipe that breaks is the main process going away; there is no one to report to.
            let _ = echo(&mut io::stdin().lock(), &mut io::stdout().lock());
            EXIT_OK
        }
        HelperMode::RemoveContainer => match container::delete(HELPER_PROFILE) {
            Ok(()) => EXIT_OK,
            Err(_) => EXIT_FAILED,
        },
    }
}

fn echo(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    output.write_all(&READY)?;
    output.flush()?;
    let mut buffer = vec![0u8; ECHO_BUFFER];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        output.write_all(&buffer[..read])?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_argv_1_names_a_mode() {
        assert_eq!(
            mode_from_args(argv(&["plisto.exe", DECODE_HELPER_FLAG])),
            Some(HelperMode::Echo)
        );
        assert_eq!(
            mode_from_args(argv(&["plisto.exe", REMOVE_CONTAINER_FLAG])),
            Some(HelperMode::RemoveContainer)
        );
        assert_eq!(mode_from_args(argv(&["plisto.exe"])), None);
        assert_eq!(
            mode_from_args(argv(&["plisto.exe", "song.mp3", DECODE_HELPER_FLAG])),
            None
        );
        assert_eq!(mode_from_args(argv(&[DECODE_HELPER_FLAG])), None);
    }

    #[test]
    fn echo_sends_ready_then_every_byte_back() {
        let sent: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
        let mut out = Vec::new();
        echo(&mut sent.as_slice(), &mut out).unwrap();
        assert_eq!(out[..READY.len()], READY);
        assert_eq!(out[READY.len()..], sent[..]);
    }
}
