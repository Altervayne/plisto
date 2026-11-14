# tap-meter

The reference native plugin. It is a small Rust program that Plisto starts as a child process, with a
page. It speaks the native protocol on standard input and output, follows Plisto's audio tap in shared
memory, reports what it sees through `status`, feeds level meters to its page, answers its page's calls,
drives its sidebar items and can hold Plisto's output. Read it next to the
[native plugin guide](../../docs/native.md).

## What it does

- Answers `hello` with `ready`, and every `ping` with `pong` from a reader thread that does nothing else
  slow. Everything else the reader gets is turned into frames to send without waiting on anything: API
  calls go out as `host_call` and their answers come back later as `host_result`.
- Opens the tap named by `--plisto-tap` read-only, follows the ring by epoch and cursor, and measures peak
  and RMS levels per channel.
- Reports through `status`, using only the three states Plisto accepts (see below), and mirrors each
  status into its sidebar status item.
- Logs each tap record: a new epoch after a start or a seek, the same epoch with a new record after a
  gapless change or a format change. Counts overruns and logs them.
- Keeps the last `feed` event, so it knows whether playback is paused or stopped from the first
  `snapshot` on. Logs each event but volume changes, `lost` when it is not 0, and the output device id.
- Sends `levels` page events ten times a second while its page is open, and none while it is closed.
- Answers its page's `call`: `ping` answers `{ "pong": true, "seq": n }`, any other name is an error
  the page sees as `plugin_error`.
- Confirms the "Mirroring" toggle with `ui.sidebar.update` and shows a chip while it is on. The "Ask me"
  action raises a `ui.confirm` prompt with the click's gesture, then a toast with the answer.
- Logs every refused API call with its code, and every `takeover_state` with its reason.
- Ignores message types and fields it does not know, so a newer Plisto never breaks it.
- Exits cleanly on `shutdown` and when standard input ends, releasing the output if it holds it.

## How its status reads

| State | When | Text |
| --- | --- | --- |
| `on` | Audio is playing through the tap. | The peak of each channel, such as `peak -6.0 -6.0 dB`. |
| `idle` | Playback is paused or stopped, or the tap is open and silent. | `paused`, `stopped` or `silent`. |
| `warn` | Plisto gave it no tap, or the tap cannot be opened. | `no tap` or `tap not open`. |

In Plisto's sidebar `on` is a cyan dot, `idle` a grey one and `warn` an amber one, with the text as the
tooltip. A status goes out only when it changes, and at most once a second. While tap-meter holds
Plisto's output the text starts with `holding output;`, which the Sound popover shows beside the takeover. The text is cleaned in one
place, `clean_status_text` in `src/protocol.rs`, so it is always 1 to 60 characters with no control
characters.

## Files

| Path | What it is |
| --- | --- |
| `plugin.json` | The manifest: a native plugin with a page, the four audio capabilities, the UI ones and a sidebar section. |
| `page/` | The page: `index.html`, `page.js`, `page.css` and a copy of the SDK. |
| `src/protocol.rs` | The wire protocol: frames and every message type. Lift it as it is. |
| `src/tap.rs` | The tap reader for layout v1: open the mapping, follow epochs, detect overruns. Lift it as it is. |
| `src/meter.rs` | Peak and RMS per channel, and the peak text. |
| `src/status.rs` | Which `status` state fits what the tap is doing, and the gate that limits how often it is sent. |
| `src/session.rs` | Everything said back to Plisto beyond pings and levels: page calls, sidebar input, API calls and their answers, the feed log. |
| `src/feed.rs` | The fields read from a `feed` event, its log lines, and the epoch log of the tap's records. |
| `src/page.rs` | The pace of the `levels` page events. |
| `src/takeover.rs` | Asking for Plisto's output once per run, and the meaning of each `takeover_state` reason. |
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

The tests include ones that start the built program, pipe it `hello`, `ping`, page calls, sidebar input,
`page` and `takeover_state` and check the answers, and one that feeds it a tap written by the test and
waits for an `on` status.

## Install into Plisto

1. Run `.\pack.ps1`. It builds a release and makes `dist\dev.plisto.tapmeter`:

       plugin.json
       bin\tap-meter.exe
       page\index.html, page.css, page.js, plisto-sdk.js

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
same folder. Every line below is in both.

| What you do | What tap-meter logs or shows |
| --- | --- |
| Turn it on | `... granted ...` with the capabilities, `tap opened: ...`, `feed snapshot: <state>, tap epoch N`, `output device id ...`. Paused at that moment: the status says `paused` at once. |
| Play, seek, change track | `feed start ...` or `feed seek ...`, then `new epoch N: <rate> Hz, <ch> ch`. A gapless pair: `epoch N continues: new record ...`. |
| Lose feed events | `feed lost N event(s) before seq S`. Nothing in normal play. |
| Open its page (the "Meters" item) | `page open: sending levels 10 times a second`; the meters move. Close it: `page closed: levels stopped`. |
| Press Ping on the page | The page shows the answer, or the error code. "Call a missing method" shows `plugin_error` with tap-meter's message. |
| Click "Mirroring" | `mirroring turned on; confirming`; the toggle settles and a "Mirroring" chip appears. |
| Press "Ask me" | `prompt asked with the click's gesture`; the prompt; then `prompt confirmed` or `prompt cancelled` and a toast. |
| A refused API call | `<call> refused: <code>`, such as `prompt without a gesture refused: denied (no_gesture)`. |
| `takeover_state` | `takeover_state <reason> (held <bool>): ...` for every reason. |

## Test flags

The manifest has no field for extra arguments, so the test flags are read from a text file named
`tap-meter.flags`, beside the executable (`bin\tap-meter.flags`). Flags are separated by spaces or new
lines, and `#` starts a comment. The same flags work on the command line, which is how the tests use them.
The program reads the file at every start.

There are two ways to set the flags:

- **Before you install.** `pack.ps1 -Flags "--stall 10"` writes the file into the packed folder.
- **After you install, to try several flags in turn.** Edit `bin\tap-meter.flags` in the installed copy,
  `%APPDATA%\com.altervayne.plisto\plugins\dev.plisto.tapmeter\` (create the file if it is not there),
  then press Restart on the plugin's row in Settings > Plugins. The new process reads the edited file. No
  reinstall is needed: Plisto checks `plugin.json`, not the other files. Empty the file to run without
  flags.

| Flag | What it shows |
| --- | --- |
| `--crash-after <secs>` | Exits with code 3, abruptly, that many seconds after `ready`. A supervisor that restarts a crashing plugin, and gives up after repeated crashes, shows its behavior with this. |
| `--stall <secs>` | Stops answering `ping` and page calls for that many seconds, then answers again. The window opens at the second ping, about two seconds after the plugin starts, and lasts the given time. It shows a plugin that is not responding and then recovers. To see a page call run into Plisto's 10-second timeout, use `--stall 10` or more, keep the page open, press Restart, and click Ping within the window: the page shows `timeout` about 10 seconds later. |
| `--takeover` | Sends `takeover` with `hold: true` after `ready`, once per run: after a refusal or a release it does not ask again until it is started again. On a clean exit it sends `hold: false` if it still holds the output. It shows Plisto muting its own output and restoring it. |
| `--prompt-unprompted` | Asks once per run for a `ui.confirm` prompt with no gesture, at the first time the page closes. Open the page (the "Meters" item), then leave it: no prompt appears, and the log shows `asking for a prompt with no gesture and no open page` then `prompt without a gesture refused: denied (no_gesture)`. The closed state Plisto reports at start does not count, so the prompt budget is left for "Ask me". |
| `--plisto-tap <name>` | Overrides the tap name, to read a mapping you made by hand. |

Seconds are a plain number: `2`, `0.5`, `5s`. A flag it does not understand is reported on standard error
and ignored.

## Using it as a starting point

Copy the folder. Change `id`, `name` and `author` in `plugin.json`, and the `entry` if you rename the
program. Keep `protocol.rs` and `tap.rs` and write your own `main.rs`, `session.rs` and `meter.rs`. The
rules that matter are in `main.rs`: one thread answers pings and never waits on anything slow, frames are
written through one lock, standard output carries only frames, and the process exits when input ends.
