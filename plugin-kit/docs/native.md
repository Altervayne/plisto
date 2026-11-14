# Native plugins

This page covers the native tier: a plugin that is a program Plisto starts and talks to. It explains when
to choose it, what the manifest needs, how Plisto launches the process, the wire protocol in full, the
audio tap, and what happens at each step of the plugin's life. The last section lists what Plisto does not
do yet. The working reference is [`examples/tap-meter`](../examples/tap-meter/README.md), a small Rust
program that implements everything here.

## What a native plugin is

A native plugin is a Windows executable. Plisto starts it as a child process when the user turns the
plugin on, sends it messages on its standard input, reads its answers from its standard output, and stops it
when the plugin is turned off or Plisto quits. The program can be written in any language that can read and
write a pipe.

It runs with the user's own rights. Nothing sandboxes it. For that reason the user sees a heavier review
sheet for a native plugin than for a page plugin, with the reason you give in `native_reason`.

### When to choose it

Choose the native tier only when the UI tier cannot do the job. The UI tier is a sandboxed web page that
cannot read audio, cannot run code while it is not on screen beyond a background page, and cannot use
anything the browser engine does not offer. Choose native when you need one of these:

- To read the audio Plisto is playing, sample by sample, in real time (the audio tap).
- To follow playback state as events, with the position, device and latency.
- To hold Plisto's own output silent while you play the sound yourself.
- To run native code: a network protocol, a device driver, a library with no web equivalent.

If a page can do it, write a page. A native plugin can have a page too: its page is an ordinary UI-tier
page, and the page and the program talk through Plisto (see "Not available yet").

## The manifest

A native plugin's `plugin.json` is the one described in the [manifest reference](manifest.md), with these
differences.

| Field | Native rule |
| --- | --- |
| `tier` | `"native"`. |
| `entry` | A relative path to an `.exe` file inside the folder, for example `bin/tap-meter.exe`. |
| `native_reason` | Required. 1 to 280 characters, shown on the review sheet. Say plainly why a page is not enough. |
| `capabilities` | The audio capabilities below are allowed. `background` is not: a native plugin runs whenever it is on. |

The `entry` rules about paths are the same as for any file: forward slashes, letters, digits, `.`, `_` and
`-`, no `..`, no device names.

### Audio capabilities

| Capability | What it lets the plugin do |
| --- | --- |
| `audio.tap` | Plisto passes the name of the tap mapping at start and keeps the tap running while the plugin runs. |
| `audio.events` | Plisto sends `feed` messages: playback snapshots. |
| `audio.device` | Named in the manifest vocabulary. No message of protocol v1 depends on it yet. |
| `audio.output_takeover` | The plugin may send `takeover` to hold Plisto's local output. |

The user approves the list on the review sheet. Ask only for what you use. The UI capabilities (`ui.toast`,
`ui.confirm`, `ui.chips`, `ui.sidebar`) and `storage` also apply to native plugins. The program learns which
ones were granted from the `granted` list in `hello`.

## How Plisto launches the process

- **Arguments.** Always these three, in this order:
  `--plisto-protocol 1 --plisto-data <dir> --plisto-tap <name|none>`. `<dir>` is the data folder.
  `<name>` is the tap mapping's name when the plugin has `audio.tap`, and `none` otherwise.
- **Working directory.** The plugin's own folder, where `plugin.json` is. Plisto replaces this folder on an
  update, so never write into it.
- **Data directory.** `--plisto-data`, which is `plugins-data\<plugin id>\` inside Plisto's app data
  folder (`%APPDATA%\com.altervayne.plisto\` on Windows). It is yours to write, and it survives updates.
  Plisto creates it before the launch.
- **Environment.** `WEBVIEW2_USER_DATA_FOLDER` is set to `webview2` inside the data directory, so a program
  that hosts a web view keeps its profile out of the code folder.
- **Console.** None. The process gets no console window.
- **Standard input and output.** Both are the protocol pipes. Write nothing else to standard output, ever:
  a stray `println!` breaks the frame stream. Use standard error or the `log` message instead.
- **Standard error.** Goes to `stderr.log` in the data directory. The file is truncated at every launch, so
  it holds the last run only.
- **The job.** Plisto starts the process suspended, puts it in a Windows Job Object set to kill its members
  when the job closes, and only then lets it run. Every process your program starts joins the job. When
  Plisto exits, in any way, including being killed in Task Manager, the system closes the job and kills the
  whole tree. A native plugin cannot outlive Plisto. Do not rely on a cleanup that runs after that.

## Protocol v1

The two sides exchange **frames** over the pipes. Plisto starts the conversation.

### Frame format

A frame is:

1. the length of the JSON body in bytes, in decimal ASCII digits;
2. a newline (`\n`);
3. the JSON body, one compact object;
4. a newline.

For example, `{"type":"shutdown"}` is 19 bytes and travels as `19\n{"type":"shutdown"}\n`.

- The body is at most 1 MiB (1,048,576 bytes). Plisto refuses a longer one before reading it, and your
  program should do the same.
- The length is 1 to 7 digits, with no sign and no spaces. Anything else is a broken frame.
- A frame is complete only with its closing newline. A body that is not followed by one is a broken frame.
- A broken frame ends the stream: Plisto stops reading your output and treats the process as gone. After a
  broken frame nothing can be trusted to be in step.
- A frame that is complete but is not understood is skipped, and the stream goes on. That covers JSON that
  is not an object, an object with no string `type`, an unknown `type` and a known `type` with wrong
  fields. Unknown fields on a known type are ignored. This is how the protocol grows: ignore what you do not
  know, in both directions.

Write each frame with a single write, and flush. If your program has several threads that write, hold a
lock for the whole frame, so two frames never interleave.

### The handshake

1. Plisto sends `hello`.
2. Your program answers `ready` within **10 seconds** of the launch. The first start after an install can
   sit behind a virus scan, so the deadline is generous. Do your slow start-up work after `ready`.
3. If `ready` carries another protocol version, or does not come, or the process ends first, Plisto kills
   the process and the plugin does not start. Anything you send before `ready` is dropped.

### Messages from Plisto to your program

| `type` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocol` (number), `api_version` (number), `plisto_version` (string), `id` (string), `granted` (list of capability names) | The first message. Answer with `ready`. `protocol` and `api_version` are both `1`. |
| `ping` | `seq` (number) | Answer with `pong` and the same `seq`. See the ping rule. |
| `shutdown` | none | Exit now. |
| `call` | `seq` (number), `method` (string), `args` (any JSON) | A call from the plugin's own page. `method` is the name the page used, without the `plugin.` prefix. Answer with `result` and the same `seq`. |
| `feed` | `event` (object), `lost` (number) | A playback snapshot. `lost` counts the snapshots you missed since your previous `feed`. There is no `seq` on the frame: the only counter is `event.seq`. See "The feed". |
| `host_result` | `seq` (number), `ok` (boolean), `result` (any JSON, optional), `error` (object, optional) | The answer to your `host_call` with the same `seq`. A failure carries `error` as `{code, message, reason?, retry_after_ms?}`. |
| `sidebar_input` | `item_id` (string), `value` (boolean or null), `gesture` (string) | The user used one of your sidebar items: a toggle (`value` is its new state) or an action (`value` is null). Treat `gesture` as an opaque token and never log it. |
| `takeover_state` | `held` (boolean), `reason` (string) | Whether you hold Plisto's local output, and why that changed. `reason` is one of `granted`, `released`, `denied`, `busy`, `user`, `not_responding` and `stopped`. |
| `page` | `open` (boolean) | Your plugin's page was shown or hidden. |

### Messages from your program to Plisto

| `type` | Fields | Meaning |
| --- | --- | --- |
| `ready` | `protocol` (number) | The answer to `hello`. Always `1` for this protocol. |
| `pong` | `seq` (number) | The answer to `ping`, with the same `seq`. |
| `status` | `state` (`on`, `idle` or `warn`), `text` (string, optional) | What the plugin is doing, for its status dot. See "Status". |
| `result` | `seq` (number), `ok` (boolean), `result` (any JSON, optional), `error` (object with an optional `message` string, optional) | The answer to a `call`. |
| `takeover` | `hold` (boolean) | Ask to hold (`true`) or release (`false`) Plisto's local output. Needs `audio.output_takeover`. |
| `host_call` | `seq` (number), `method` (string), `args` (any JSON) | Call a Plisto API method, the same ones a page uses. The answer is `host_result` with the same `seq`. |
| `page_event` | `topic` (string, 1 to 64 characters from `a-z`, `0-9`, `_`, `.` and `-`), `data` (any JSON) | Pushed to the plugin's page. |
| `log` | `level` (`debug`, `info`, `warn` or `error`; default `info`), `text` (string) | One line for the plugin's log. See "Logging". |

Unknown fields are ignored in both directions, and so are message types you do not know. An integer is a
JSON number no larger than 2^53.

### Status

`status` says what the plugin is doing in three words, so Plisto can show it the same way for every plugin.
It is a closed vocabulary; any other `state` makes the frame malformed.

| `state` | Use it for | In Plisto's sidebar |
| --- | --- | --- |
| `on` | The plugin is working. | A cyan dot. |
| `idle` | Nothing to do right now: paused, stopped, silent. | A grey dot. |
| `warn` | Something is wrong but the plugin goes on, such as a missing device. | An amber dot. |

`text` is the dot's tooltip. Plisto trims it, then it must be 1 to 60 characters with no control characters
and no invisible or direction-changing characters (zero-width characters, line and paragraph separators,
bidirectional overrides and isolates, the byte order mark); a text that breaks the rule makes the whole frame malformed, so cut and clean it before you send it, in one
helper. Plisto applies at most one `status` per second, so send one only when the state or the text
changes, and not more than once a second.

Plisto's own states override what you report. While the plugin is starting, not responding or restarting,
the dot and tooltip are Plisto's ("Starting", "Not responding", "Stopped unexpectedly"), whatever your last
`status` said. A plugin that has reported nothing shows no dot.

### The ping rule

From `ready` on, Plisto sends a `ping` every second. Answer each one with a `pong` carrying the same `seq`.
Three seconds without a valid `pong` and Plisto shows the plugin as not responding. If the plugin held
Plisto's output, Plisto takes it back at that moment. A `pong` that arrives later marks the plugin healthy
again, but the output stays with Plisto until the plugin asks for it again. Plisto never kills a plugin for
silence alone.

A `pong` is valid when its `seq` is one Plisto has sent and has not yet had answered. Any other `pong` is a
protocol error and is ignored.

So read standard input on a **dedicated thread** that does nothing else slow: it reads frames, answers
pings at once, and hands other work to other threads. A program that does its heavy work on the thread that
reads standard input looks hung while it works. Keep the reader's work to parsing a frame and a few stores.
Do not let it wait on a lock another thread holds for long, on a disk, on the network or on a full queue.

### Exit

Exit when you receive `shutdown`, and when standard input ends (Plisto is gone or has dropped you). Plisto
waits 2 seconds after `shutdown`, then kills the process and everything it started.

### Crashes and restarts

Plisto counts these as a crash: an exit it did not ask for, with any code (the code is not read); a broken
frame; the end of the plugin's output. After a crash Plisto kills whatever is left of the process, takes
back the output if the plugin held it, and starts the plugin again after 1 second, then 2, then 4. Three
crashes within 60 seconds turn the plugin off and tell the user. A run that lasts 60 seconds counts as
stable and starts the sequence over.

### Protocol errors

A frame that is complete but wrong is skipped and counted, and the stream goes on: an unknown or
malformed message, a known type with wrong fields, a `status` with a bad state or text, a `result` whose
`seq` matches no call, a `pong` out of range, a `host_call` whose `seq` is already open. A frame that is
broken (bad length, over the size cap, torn) ends the process, since nothing after it can be trusted to be
in step, and counts as a crash. The size cap is 1 MiB for each frame, in both directions.

## The audio tap

The tap is a copy of the audio Plisto plays, in shared memory. It is taken from each track after Plisto's
own sound processing and before the output volume. Your program receives the volume in `feed` events and
applies it itself if it wants to mirror what the user hears. Short stretches of silence that Plisto
inserts at the start of a cold start never enter the tap.

Plisto only writes the tap while at least one plugin with `audio.tap` is running. The writer never waits
for a reader and never reads reader state, so a slow or dead plugin cannot stall playback. A reader that
falls behind loses samples and is told so by the cursor gap (see "Overruns").

### Opening it

`--plisto-tap` is the name of a named file mapping, `Local\plisto-tap-<pid>-<nonce>`. Open it read-only:
`OpenFileMappingW` with `FILE_MAP_READ`, then `MapViewOfFile` over `4096 + 4 * 2^20` bytes (4,198,400).
Check the header before you trust it. The mapping is kept for the life of Plisto, and
any number of readers may open it.

### Layout v1

All fields are little-endian. All offsets are in bytes from the start of the mapping.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `magic`: the bytes `PTAP`. |
| 4 | 4 | `layout_version`: `1`. |
| 8 | 4 | `capacity`: samples in the ring, `1048576`. |
| 12 | 4 | `segment_count`: records in the record ring, `64`. |
| 16 | 8 | `write_cursor`: samples written since the mapping was created. Read it with acquire ordering. |
| 24 | 8 | `segment_cursor`: records written since the mapping was created. Read it with acquire ordering. |
| 32 | 64 x 24 | The segment records. |
| 4096 | 4 x `capacity` | The sample ring. |

Refuse a mapping whose magic, version, capacity or segment count differ: it is a different layout.

A **sample** is a 32-bit float in its native bit pattern, interleaved by channel, at the source's own rate
and channel count: the tap is not resampled or remixed. Sample number `n` (counted from the creation of the
mapping) is in slot `n mod capacity`. The samples between `write_cursor - capacity` and `write_cursor` are
in the ring; anything older is overwritten.

A **segment record** is 24 bytes, and record number `k` is in slot `k mod 64`:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | `start_cursor`: the sample number where this segment begins. |
| 8 | 4 | `epoch`: see below. |
| 12 | 4 | `rate`: sample rate in Hz. |
| 16 | 4 | `channels`: channel count. |
| 20 | 4 | Reserved. |

A segment governs the samples from its `start_cursor` up to the next record's. The channel of sample `n`
is `(n - start_cursor) mod channels`. A new record is written when playback starts, when the track
changes, and when the rate or the channel count changes. The record is written before the samples it
covers are published, so a `start_cursor` can be ahead of `write_cursor`: keep the record until your
cursor reaches it.

### Epochs

The `epoch` rises on every cold start: a play, a skip, a load, a restore or a seek. A record with a new
epoch follows a **discontinuity**: the samples before it and after it are not one continuous signal, so
flush filters, delay lines and accumulators. A gapless boundary between two tracks, and a format change,
get a new record with the **same** epoch: the signal continues, with a new format.

### Reading it

1. Start at the live position: your cursor is `write_cursor`, and your record index is
   `segment_cursor - 2` (not below 0), so the record that governs your cursor is among the ones you read.
2. Repeat, a few tens of times a second:
   - read `write_cursor`; the samples from your cursor up to it are published;
   - read the new records, in order, and note each `start_cursor`, `epoch`, `rate` and `channels`;
   - copy the samples in chunks, never past the next record's `start_cursor`, applying the segment in
     force;
   - after each copy, read `write_cursor` again (with a fence between), and discard the copy if it shows
     the writer lapped the slots you read.

### Overruns

The writer may have stored a little past the published `write_cursor` (up to 2,048 samples, which is 64
frames of 32 channels). So keep your cursor at least that far from the writer's wrapping point. A reader has
**overrun** when

    write_cursor - cursor > capacity - 2048

that is, more than 1,046,528 samples behind. At 48,000 Hz stereo that is a little under 11 seconds. The
same holds for the record ring: when `segment_cursor - index >= 64`, the records you wanted are gone.

On an overrun, do not try to repair the signal. Count it, discard what you hold, and resync to the live
position as in step 1. The same check after a copy catches the writer overtaking you mid-read.

### The feed

A plugin with `audio.events` receives `feed` messages. The `event` object has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | number | Rises by one per snapshot Plisto takes, shared by every plugin, so your first value can be any number. A gap after it means you missed events. |
| `cause` | string | Why the snapshot was taken: `start`, `gapless`, `pause`, `resume`, `seek`, `stop`, `volume`, `device` or `snapshot`. A `snapshot` is sent once when you start receiving events and carries the current state. |
| `tap_epoch` | number | The tap's latest epoch when the snapshot was taken. |
| `tap_cursor` | number | The tap's `write_cursor` when the snapshot was taken. What the event changes reaches the ring at or after it. |
| `transport` | string | `playing`, `paused` or `stopped`. |
| `sample_rate` | number | The current source's rate, `0` when stopped. |
| `channels` | number | The current source's channel count, `0` when stopped. |
| `position_secs` | number | The play head, in seconds. |
| `volume` | number | The user's volume, 0 to 1. The tap is taken before it. |
| `device` | string or null | The name of the output device Plisto renders to, null when none is open. |
| `device_id` | string or null | The Windows endpoint ID of that device, null when none is open or it could not be matched. Two devices can share a name; the ID tells them apart. |
| `latency_ms` | number | The device's buffer period, a good estimate of the output delay. |

Each plugin has its own bounded queue of events. If you are slow, the newest events are dropped and the
`seq` gap shows it, and `lost` on the frame counts them. Keep the last snapshot you received and treat it
as the current state. Do not depend on every event arriving.

## Life of a native plugin

- **Install.** The folder is checked like any plugin's, and the entry must be an existing `.exe`. The
  plugin installs turned off. Nothing runs until the user reviews and enables it.
- **Enable.** Plisto checks the folder and the manifest again, then launches the process and sends
  `hello`. A plugin that does not reach `ready` in 10 seconds is killed and not started.
- **Disable, uninstall, update.** Plisto sends `shutdown`, waits 2 seconds for the process to
  exit, then kills it and whatever it started. An update stops the plugin and replaces the folder; the data
  directory is kept.
- **Plisto exits.** The same stop runs for every plugin in parallel, within one 2-second grace. If Plisto
  is killed instead, the job kills the plugin.
- **Not started.** A native plugin does not start in safe mode, and does not start after an unclean exit
  until the user has chosen how to start.
- **Your process exits by itself.** That is a crash: see "Crashes and restarts".

## Logging

- Everything on standard error goes to `stderr.log` in the data directory, truncated at each launch. This
  is the log to read when the plugin will not start. Flush it, or the last lines are lost when you crash.
- `log` messages are written to `plugin.log` in the same folder, next to the page plugins' (see
  [lifecycle](lifecycle.md)). They are rate-limited: lines over the limit are dropped and counted. Text is
  cut at 2,000 characters.
- Do not log secrets or personal data, and do not log in a tight loop.

## Not available yet

The protocol above is complete, but Plisto does not act on every message yet, so a plugin written today
cannot rely on these:

- **The page relay.** Plisto does not forward `call` from the plugin's page and does not read `result`.
- **Plugin API calls.** Plisto does not read `host_call` and sends no `host_result`.
- **Page events.** Plisto reads `page_event` and drops it.
- **Sidebar input.** Plisto sends no `sidebar_input`.
- **The feed and the tap name.** Plisto sends no `feed` messages, and `--plisto-tap` is `none`: it does
  not pass a mapping name or turn the tap on for a plugin. To test against a tap today, give the process
  a mapping name by hand.
- **Output takeover.** Plisto reads `takeover` and drops it; its output stays on, and it sends no
  `takeover_state`.

Each of these arrives without a change to the protocol version: new behavior only adds. A plugin that
ignores what it does not understand keeps working.
