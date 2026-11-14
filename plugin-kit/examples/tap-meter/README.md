# tap-meter

The reference native plugin. It is a small Rust program that Plisto starts as a child process. It speaks
the native protocol on standard input and output, follows Plisto's audio tap in shared memory, and reports
peak and RMS levels per channel. Read it next to the [native plugin guide](../../docs/native.md).

## What it does

- Answers `hello` with `ready`, and every `ping` with `pong` from a reader thread that does nothing else
  slow.
- Keeps the last `feed` event, so its status line shows the playback state.
- Opens the tap named by `--plisto-tap` read-only, follows the ring by epoch and cursor, and every quarter
  second sends a `status` line such as `playing, peak -6.0 -6.0 dB, rms -9.1 -9.2 dB, overruns 0`.
- Counts overruns and logs them, with each new epoch, through `log` and standard error.
- Answers any `call` with an error result, so a caller never waits.
- Exits cleanly on `shutdown` and when standard input ends.

## Files

| Path | What it is |
| --- | --- |
| `plugin.json` | The manifest: a native plugin with `audio.tap` and `audio.events`. |
| `src/protocol.rs` | The wire protocol: frames and every message type. Lift it as it is. |
| `src/tap.rs` | The tap reader for layout v1: open the mapping, follow epochs, detect overruns. Lift it as it is. |
| `src/meter.rs` | Peak and RMS per channel, and the status line. |
| `src/args.rs` | The command line and the flags file. |
| `src/main.rs` | The two threads that tie the above to the protocol. |
| `src/test_ring.rs` | A tap writer for tests. |
| `tests/process.rs` | Runs the built program the way Plisto does. |
| `pack.ps1` | Builds a release and lays out a folder Plisto can install. |

The crate has an empty `[workspace]` table, so it never joins Plisto's own build. It needs a Rust
toolchain for Windows and nothing else. Its only dependencies are `serde`, `serde_json` and `windows-sys`.

## Build and test

In this folder:

    cargo build --release
    cargo test
    cargo clippy --all-targets

The tests include one that starts the built program, pipes it `hello` and `ping` and checks for `ready` and
`pong`, and one that feeds it a tap written by the test.

## Install into Plisto

1. Run `.\pack.ps1`. It builds a release and makes `dist\dev.plisto.tapmeter`:

       plugin.json
       bin\tap-meter.exe

   `pack.ps1 -Flags "--stall 5"` also writes `bin\tap-meter.flags` with that text (see below).
2. In Plisto, open Settings > Plugins, choose Install from folder and pick `dist\dev.plisto.tapmeter`.
3. Read the review sheet. A native plugin shows the reason from `plugin.json` and asks for confirmation.
   Press Install, then turn the plugin's switch on.
4. To stop it, turn the switch off, or quit Plisto. The process cannot outlive Plisto.

To update, run `pack.ps1` again and install the folder again: the same `id` is an update. Raise `version`
in `plugin.json` first.

## Where to look

Everything the program writes to standard error is in `stderr.log` inside the plugin's data folder,
`%APPDATA%\com.altervayne.plisto\plugins-data\dev.plisto.tapmeter\`. It includes a line naming the
Plisto version and the capabilities granted, and it is truncated at each launch.

This release of Plisto does not show the plugin's `status` or `log` messages yet and does not pass a tap
name, so the log file is the place to confirm that it started and said `ready`. Once Plisto passes a tap
name and delivers feed events and pings, the program opens the tap and reports levels as described above.
See "Not available yet" in the guide.

## Test flags

The manifest has no field for extra arguments, so the test flags are read from a text file named
`tap-meter.flags`, beside the executable (`bin\tap-meter.flags`). Flags are separated by spaces or new
lines, and `#` starts a comment. The same flags work on the command line, which is how the tests use them.
Put the file in place with `pack.ps1 -Flags`, before you install.

| Flag | What it shows |
| --- | --- |
| `--crash-after <secs>` | Exits with code 3, abruptly, that many seconds after `ready`. A supervisor that restarts a crashing plugin, and gives up after repeated crashes, shows its behavior with this. |
| `--stall <secs>` | Stops answering `ping` for that many seconds, from the second ping on, then answers again. It shows a plugin that is not responding and then recovers. |
| `--takeover` | Sends `takeover` with `hold: true` after `ready`, and `hold: false` on a clean exit. It shows Plisto muting its own output and restoring it. |
| `--plisto-tap <name>` | Overrides the tap name, to read a mapping you made by hand. |

Seconds are a plain number: `2`, `0.5`, `5s`. A flag it does not understand is reported on standard error
and ignored.

## Using it as a starting point

Copy the folder. Change `id`, `name` and `author` in `plugin.json`, and the `entry` if you rename the
program. Keep `protocol.rs` and `tap.rs` and write your own `main.rs` and `meter.rs`. The rules that
matter are in `main.rs`: one thread answers pings and does nothing else, frames are written through one
lock, standard output carries only frames, and the process exits when input ends.
