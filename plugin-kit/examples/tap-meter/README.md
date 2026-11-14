# tap-meter

The reference native plugin. It is a small Rust program that Plisto starts as a child process. It speaks
the native protocol on standard input and output, follows Plisto's audio tap in shared memory, and reports
what it sees through `status`. Read it next to the [native plugin guide](../../docs/native.md).

## What it does

- Answers `hello` with `ready`, and every `ping` with `pong` from a reader thread that does nothing else
  slow.
- Keeps the last `feed` event, so it knows whether playback is paused or stopped.
- Opens the tap named by `--plisto-tap` read-only, follows the ring by epoch and cursor, and measures peak
  and RMS levels per channel.
- Reports through `status`, using only the three states Plisto accepts (see below).
- Counts overruns and logs them, with each new epoch, through `log` and standard error.
- Remembers whether its page is open (`page`). Nothing uses that yet.
- Decodes `sidebar_input`, `takeover_state` and `host_result` and ignores them, apart from logging the
  `takeover_state` answer to standard error. Any `call` gets an error `result`, so a caller never waits.
- Ignores message types and fields it does not know, so a newer Plisto never breaks it.
- Exits cleanly on `shutdown` and when standard input ends.

## How its status reads

| State | When | Text |
| --- | --- | --- |
| `on` | Audio is playing through the tap. | The peak of each channel, such as `peak -6.0 -6.0 dB`. |
| `idle` | Playback is paused or stopped, or the tap is open and silent. | `paused`, `stopped` or `silent`. |
| `warn` | Plisto gave it no tap, or the tap cannot be opened. | `no tap` or `tap not open`. |

In Plisto's sidebar `on` is a cyan dot, `idle` a grey one and `warn` an amber one, with the text as the
tooltip. A status goes out only when it changes, and at most once a second. The text is cleaned in one
place, `clean_status_text` in `src/protocol.rs`, so it is always 1 to 60 characters with no control
characters.

## Files

| Path | What it is |
| --- | --- |
| `plugin.json` | The manifest: a native plugin with `audio.tap` and `audio.events`. |
| `src/protocol.rs` | The wire protocol: frames and every message type. Lift it as it is. |
| `src/tap.rs` | The tap reader for layout v1: open the mapping, follow epochs, detect overruns. Lift it as it is. |
| `src/meter.rs` | Peak and RMS per channel, and the peak text. |
| `src/status.rs` | Which `status` state fits what the tap is doing, and the gate that limits how often it is sent. |
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

The tests include ones that start the built program, pipe it `hello`, `ping` and unknown messages and check
the answers, and one that feeds it a tap written by the test and waits for an `on` status.

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

The plugin's `status` shows in Plisto's sidebar, and its `log` messages are written to `plugin.log` in the
same folder. At this stage Plisto does not pass a tap name or send `feed`, so the plugin reports `warn`
with `no tap`. See "Not available yet" in the guide.

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
