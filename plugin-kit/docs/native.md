# Native plugins

This page covers the native tier: a plugin that is a program Plisto starts and talks to. It explains when
to choose it, what the manifest needs, how Plisto launches the process, the wire protocol in full, how the
program works with its page and its sidebar items, the audio tap and feed, output takeover, and what
happens at each step of the plugin's life. The working reference is [`examples/tap-meter`](../examples/tap-meter/README.md), a small Rust program with a page
that implements everything here.

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
page, and the page and the program talk through Plisto (see "The page and the program").

## The manifest

A native plugin's `plugin.json` is the one described in the [manifest reference](manifest.md), with these
differences.

| Field | Native rule |
| --- | --- |
| `tier` | `"native"`. |
| `entry` | A relative path to an `.exe` file inside the folder, for example `bin/tap-meter.exe`. |
| `native_reason` | Required. 1 to 280 characters, shown on the review sheet. Say plainly why a page is not enough. |
| `page` | Optional. A relative path to an `.html` file inside the folder: the plugin's page, an ordinary sandboxed page that loads the SDK. A sidebar `nav` item needs it. A UI plugin may not set it: its page is its `entry`. |
| `capabilities` | The audio capabilities below are allowed. `background` is not: a native plugin runs whenever it is on. |
| `sidebar` | As for any plugin (see the [sidebar guide](sidebar.md)), except that live items (`status`, `progress`, `toggle`, `action`) need no `background`: the program is what keeps them live. |

The `entry` rules about paths are the same as for any file: forward slashes, letters, digits, `.`, `_` and
`-`, no `..`, no device names.

### Audio capabilities

| Capability | What it lets the plugin do |
| --- | --- |
| `audio.tap` | Plisto passes the name of the tap mapping at start and keeps the tap running while the plugin runs. |
| `audio.events` | Plisto sends `feed` messages: playback snapshots. |
| `audio.device` | `feed` events carry the output device's name and id. Without it both are null, since a device name often carries a person's name. Needs `audio.events`. |
| `audio.output_takeover` | The plugin may send `takeover` to hold Plisto's local output. See "Output takeover". |

The user approves the list on the review sheet. Ask only for what you use. The UI capabilities (`ui.toast`,
`ui.confirm`, `ui.chips`, `ui.sidebar`) and `storage` also apply to native plugins. The program learns which
ones were granted from the `granted` list in `hello`.

## How Plisto launches the process

- **Arguments.** Always these three, in this order:
  `--plisto-protocol 1 --plisto-data <dir> --plisto-tap <name|none>`. `<dir>` is the data folder.
  `<name>` is the tap mapping's name when the plugin has `audio.tap`, and `none` otherwise.
- **Working directory.** The plugin's own folder, where `plugin.json` is:
  `%APPDATA%\com.altervayne.plisto\plugins\<plugin id>\`. Plisto replaces this folder on an update, so never
  write into it.
- **Data directory.** `--plisto-data`, which is `plugins-data\<plugin id>\` inside Plisto's app data
  folder (`%APPDATA%\com.altervayne.plisto\` on Windows). It is yours to write, and it survives updates.
  Plisto creates it before the launch. Uninstalling with "Also delete its saved data" ticked removes the
  whole folder, your files, the logs and the `webview2` profile included.
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

To implement the frame in any language:

- The body is UTF-8 JSON, and the length counts its **bytes**, not its characters. A body with an accented
  letter is longer in bytes than in characters.
- The separators are a bare line feed, byte `0x0A`. Put standard input and output in binary mode: a runtime
  that turns `\n` into `\r\n` on Windows (the C runtime in text mode, and some language runtimes by default)
  breaks every frame, since a carriage return is not a digit.
- Read the length one byte at a time, up to the newline, then read exactly that many bytes, then one more byte
  that must be a newline. Read the body as raw bytes, not through a text reader that decodes or translates.
- Standard output carries frames and nothing else. Print your own debugging to standard error.

A minimal read loop, in pseudo-code:

```
read_frame(input):
    digits = ""
    loop:
        b = input.read_byte()
        if b is the end of input and digits is empty:  return END
        if b is the end of input:                      fail("torn frame")
        if b == "\n" and digits is not empty:          break
        if b is "0".."9" and length(digits) < 7:       digits = digits + b
        else:                                          fail("bad length")
    n = integer(digits)
    if n > 1048576:                                    fail("too large")
    body = input.read_exactly(n)                       # fail("torn frame") when the input ends early
    if input.read_byte() != "\n":                      fail("torn frame")
    return body

write_frame(output, message):
    body = utf8(json(message))
    if length(body) > 1048576:                         do not send it
    output.write(decimal(length(body)) + "\n" + body + "\n")    # one write, under the lock
    output.flush()

main:
    read the arguments --plisto-protocol, --plisto-data and --plisto-tap
    first = read_frame(stdin); it must be a "hello" message
    write_frame(stdout, {"type": "ready", "protocol": 1})
    loop:                                              # the reader thread: nothing slow on it
        body = read_frame(stdin)
        if body is END:  exit                          # Plisto is gone
        message = parse_json(body)
        if message is not an object with a string "type":  continue
        if message.type == "ping":      write_frame(stdout, {"type": "pong", "seq": message.seq})
        else if message.type == "shutdown":  exit
        else if message.type == "call":  hand it to a worker, which answers {"type": "result", "seq": ...}
        else if message.type is another type you handle:  hand it to a worker
        else:  ignore it                                # unknown types are normal
```

A `fail` in the read loop means the stream is out of step and nothing after it can be trusted, so exit.
Plisto does the same with a broken frame from the program: the run ends as a crash.

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
| `call` | `seq` (number), `method` (string), `args` (any JSON) | A call from the plugin's own page. `method` is the name the page used, without the `plugin.` prefix. Answer with `result` and the same `seq`. See "The page and the program". |
| `feed` | `event` (object), `lost` (number) | A playback snapshot. `lost` counts the snapshots you missed since your previous `feed`. There is no `seq` on the frame: the only counter is `event.seq`. See "The feed". |
| `host_result` | `seq` (number), `ok` (boolean), `result` (any JSON, optional), `error` (object, optional) | The answer to your `host_call` with the same `seq`. A failure carries `error` as `{code, message, reason?, retry_after_ms?}`. |
| `sidebar_input` | `item_id` (string), `value` (boolean or null), `gesture` (string) | The user used one of your sidebar items: a toggle (`value` is its new state) or an action (`value` is null). Treat `gesture` as an opaque token and never log it. |
| `takeover_state` | `held` (boolean), `reason` (string) | Whether you hold Plisto's local output, and why that changed. `reason` is one of `granted`, `released`, `denied`, `busy`, `user`, `not_responding` and `stopped`. |
| `page` | `open` (boolean) | Your plugin's page was shown or hidden. Also sent once right after `ready`, with the current value. |
| `stream` | `event` (object) | An event of the playback stream your plugin owns, the same object its page gets. See "Stream events". |
| `event` | `topic` (string), `data` (any JSON) | An app event of a topic your program subscribed to: `data` is the topic's payload. See "App events". |

### Messages from your program to Plisto

| `type` | Fields | Meaning |
| --- | --- | --- |
| `ready` | `protocol` (number) | The answer to `hello`. Always `1` for this protocol. |
| `pong` | `seq` (number) | The answer to `ping`, with the same `seq`. |
| `status` | `state` (`on`, `idle` or `warn`), `text` (string, optional) | What the plugin is doing, for its status dot. See "Status". |
| `result` | `seq` (number), `ok` (boolean), `result` (any JSON, optional), `error` (object with an optional `message` string, optional) | The answer to a `call`. |
| `takeover` | `hold` (boolean) | Ask to hold (`true`) or release (`false`) Plisto's local output. Needs `audio.output_takeover`. See "Output takeover". |
| `host_call` | `seq` (number), `method` (string), `args` (any JSON) | Call a Plisto API method, the same ones a page uses. The answer is `host_result` with the same `seq`. See "Calling the API". |
| `page_event` | `topic` (string, 1 to 64 characters from `a-z`, `0-9`, `_`, `.` and `-`), `data` (any JSON) | Pushed to the plugin's page while it is open. See "The page and the program". |
| `log` | `level` (`debug`, `info`, `warn` or `error`; default `info`), `text` (string) | One line for the plugin's log. See "Logging". |

Unknown fields are ignored in both directions, and so are message types you do not know. An integer is a
JSON number no larger than 2^53. Plisto keeps 64 frames waiting for a program that reads slowly and never
waits for it; what each kind of frame does when that queue is full is in
[limits](limits.md#when-the-programs-input-is-backed-up).

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

A `pong` is valid when its `seq` is above the `seq` of your last valid `pong` and not above the last `ping`
Plisto sent. So answering a ping makes every older ping stale: a late `pong` for an older one is a protocol
error and is ignored. Answer each ping in order, as it arrives.

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
`seq` matches no call, a `pong` out of range, a second `ready`, a `host_call` whose `seq` is already open. A frame that is
broken (bad length, over the size cap, torn) ends the process, since nothing after it can be trusted to be
in step, and counts as a crash. The size cap is 1 MiB for each frame, in both directions.

Plisto writes the first 16 protocol errors of a run to its own diagnostic output and only counts the rest.
Neither reaches `plugin.log` or `stderr.log`, so you will not see them there: test your frames yourself (see
"Testing your program").

### A first session

This is a session as the pipes carry it, for a plugin with `ui.toast` and a page. `>` is Plisto to the
program and `<` the program to Plisto. Each line is one frame as written: the length, `\n`, the body and
`\n`. The numbers (`seq` values, levels) are examples.

```
> 118\n{"type":"hello","protocol":1,"api_version":1,"plisto_version":"2.7.0","id":"com.example.meter","granted":["ui.toast"]}\n
< 29\n{"type":"ready","protocol":1}\n
> 28\n{"type":"page","open":false}\n
> 23\n{"type":"ping","seq":1}\n
< 23\n{"type":"pong","seq":1}\n
< 59\n{"type":"status","state":"idle","text":"waiting for audio"}\n
< 78\n{"type":"host_call","seq":1,"method":"ui.toast","args":{"text":"Meter ready"}}\n
> 27\n{"type":"page","open":true}\n
< 62\n{"type":"page_event","topic":"levels","data":{"peak_db":-6.5}}\n
> 50\n{"type":"call","seq":1,"method":"reset","args":{}}\n
< 61\n{"type":"result","seq":1,"ok":true,"result":{"cleared":true}}\n
> 72\n{"type":"host_result","seq":1,"ok":true,"result":{"result":"dismissed"}}\n
> 19\n{"type":"shutdown"}\n
```

In order:

1. Plisto starts the process, and writes `hello`. The program answers `ready` within 10 seconds.
2. Right after `ready`, Plisto tells the program whether its page is open (`page`). With `audio.events` it
   also sends a `feed` snapshot. A `ping` follows every second from then on, and each gets a `pong`.
3. The program reports `status`, and calls the API with `host_call`. Its answer comes back as `host_result`
   with the same `seq`, here about 4 seconds later: a toast's call stays open until the toast leaves.
   Other frames flow in the meantime.
4. The user opens the page, so `page` says `open: true`, and the program starts sending `page_event`. It
   sends none while the page is closed.
5. The page calls `plisto.plugin.call("reset", {})`. Plisto sends `call` with `method` `reset`, and the
   program answers `result` with the same `seq`. A program that does not know a method answers `ok: false`.
6. The user turns the plugin off. Plisto sends `shutdown` and waits 2 seconds. The program exits.

## The page and the program

A native plugin with `page` has a sandboxed page like any UI plugin, with the SDK loaded. The page cannot
reach the program directly. Plisto carries messages both ways.

### Calls from the page

The page calls `plisto.plugin.call(name, args)`. Plisto sends the program `call` with `method` set to
`name` (without the `plugin.` prefix), a `seq` of its own, and `args`. The program answers `result` with
the same `seq`:

| The program answers | The page gets |
| --- | --- |
| `result` with `ok: true` | The promise resolves with `result`, or `null` when there is none. |
| `result` with `ok: false` | `plugin_error`, with `error.message` as the message, cut to 200 characters. Without a text message the message is Plisto's own. |
| Nothing within 10 seconds | `timeout`. A `result` that comes later is a protocol error. |

Plisto answers by itself in these cases: `unavailable` when the program is not running (starting,
stopped, crashed) or its run ends while the call waits; `busy` when the frames to the program are backed
up; `too_large` when the arguments do not fit in one frame. A program that is not responding still
receives calls, and they run into the timeout if it stays silent.

- The name is one to three parts separated by dots. Each part starts with a lowercase letter and holds
  lowercase letters, digits and `_`. With the `plugin.` prefix the whole name is at most 64 characters.
  Anything else is `invalid_args`.
- Relay calls have their own budget, 40 at once then 20 per second, and count against the plugin's
  overall budget and its 16 calls in flight like any call.
- A UI plugin's `plisto.plugin.call` is `unknown_method`.

Answer every `call`, even one you do not know, so the page never waits out the timeout. Answer from a
thread that is not busy: the reader thread can answer a cheap call at once and hand a slow one to a worker.

### Page events

The program sends `page_event` with a `topic` and `data`. The page subscribes with
`plisto.onPluginEvent(topic, callback)` and the callback gets `data`.

- Plisto passes an event on only while the page is open. `page` tells you when that changes, so send
  nothing while it is closed.
- An event is at most 32 KiB, topic and serialized data together. Each plugin may send 20 at once, then 20
  per second.
- An event that breaks one of these rules is dropped and counted, never answered. A topic outside the
  name rule is a protocol error.
- Nothing is queued: a page that opens later sees later events only.

### Calling the API

The program calls Plisto's API with `host_call`, the same methods a page calls, and gets `host_result`
with the same `seq`. A call is checked exactly like a page's (see the [API reference](api.md)): the
capability, the rate budgets, the argument rules. The program and its page share the plugin's budgets.

- `net.*` and `plugin.*` methods are `unknown_method` from the program: the network belongs to the page,
  and the relay goes the other way. The `stream.*` methods work from the program: see "Stream events".
  So does `events.subscribe`: see "App events".
- At most 16 calls may be open at once; another is `busy`. A `seq` that is already open is a protocol
  error, and that call is answered `invalid_args`.
- A failure carries `error` as `{code, message, reason?, retry_after_ms?}`, the codes of the API
  reference. Log refusals by their code; never treat one as fatal.
- A call that takes a while, such as a prompt, does not hold the pipe: other frames flow while it waits.

`ui.confirm` from the program follows the prompt gate: it is shown when the plugin's page is open, or
when `args` carries a fresh `gesture`. The program gets a gesture with each `sidebar_input` and from a
toast whose action button was pressed (`{ result: "action", gesture }`). A gesture is single-use and
lasts 5 seconds. Without either, the call is refused `denied` with `reason: "no_gesture"`.

When the program crashes, is restarted or is stopped, Plisto closes what that run opened: prompts,
toasts, gestures, rate counts and sidebar state. Answers still owed to that run are dropped. What the page
opened, such as its own network requests, stays while the page does.

### Stream events

A native plugin with `playback.stream` can play audio through Plisto: the program sends `host_call` with
`stream.play`, `stream.push`, `stream.update` and the other methods of the [stream guide](stream.md). No page
needs to be open, and a start needs no user action: it pauses and parks the user's music. A URL source also
needs `network` and its origin, as for a page; a program that pushes bytes needs neither. `net.*` stays
closed to a program, so a program that wants to fetch the bytes itself uses its own network code and pushes
them.

To push, put the bytes in `args` as `data_b64`, at most 65,536 bytes decoded (about 87 KB of base64, well
inside the 1 MiB frame). A `stream.push` is `busy` when Plisto's 1 MiB buffer is full; wait for a `room` event
before pushing again.

Plisto reports the stream to its owner with the `stream` message:

```json
{"type":"stream","event":{"item":-4,"kind":"state","state":"playing"}}
{"type":"stream","event":{"item":-4,"kind":"room","room":786432}}
{"type":"stream","event":{"item":-4,"kind":"ended","reason":"network","detail":"closed"}}
```

`event` is the object the page gets from `plisto.onStream`: `kind` is `state`, `skip`, `room` or `ended`, and the
fields are in the [stream guide](stream.md#events). Every event reaches both sides of the plugin, its newest
running page and its program, whichever of them called `stream.play`.

- The event goes to the program that is running and ready. A program that was replaced, is still starting or
  is stopping hears nothing.
- If the program's input is backed up, Plisto drops the event and counts it. It is not sent again, and the
  program is not told how many it missed. After a gap, and after every restart, call `stream.state` and read
  `last_end`: it holds the end of your previous item for 60 seconds.
- A push item ends `producer_gone` when the side that called `play` goes away: if the program called `play`
  and exits, the item ends; if only the page goes away, nothing ends. Call `play` and `push` from the same
  side. A pull item the program started plays on when the program crashes, and the restarted program reads
  `stream.state`.
- Treat the `ended` reasons `user` and `replaced` as the user's choice and do not start again.

### App events

A program learns what is playing, the queue, library changes and the theme, language and app mode as
events, whether or not its page is open and with Plisto's window hidden to the tray. It subscribes with
`host_call`; the topics, payloads and pace are in the [events guide](events.md), and the program's side is
this:

```json
{"type":"host_call","seq":1,"method":"events.subscribe","args":{"topics":["playback_state","locale"]}}
{"type":"host_result","seq":1,"ok":true,"result":{"topics":["locale","playback_state"],"current":{"locale":{"locale":"fr"},"playback_state":{"transport":"paused","position_secs":12.5,"position_at":1763300000000,"duration_secs":201,"start_seq":3,"seek_seq":0,"repeat":"off","shuffle":false,"volume":0.8,"stream":null}}}}
{"type":"event","topic":"locale","data":{"locale":"en"}}
```

- **Subscribe after every `ready`.** A program's subscription ends with its run, so a restarted program
  starts with none. Send `events.subscribe` once `ready` is out; the answer carries the current value of each
  state topic, so the program needs no first read. Plisto sends no `event` from the moment it
  reads the program's `events.subscribe` call until the answer is out: the first values come in `current`.
  On a later subscribe, an `event` Plisto had already sent can still arrive before the answer; it is never
  newer than `current`, so apply `current` over it.
- **A subscribe replaces the program's whole set**, and `topics: []` clears it. Its page has its own set: the
  page and the program subscribe separately, and both receive what they asked for.
- **The grants are the page's.** `playback.read` for `now_playing`, `playback_state` and `queue`,
  `library.read` for `library_changed`, nothing for the rest. A topic without its grant is `denied` and the
  previous set stays.
- **`event` carries `topic` and `data` only.** Plisto sends it while the program is running and has answered
  `hello`. Ignore a topic you did not ask for, like any message type you do not know.
- **A full input does not lose the last value.** Where `feed` and `stream` messages are dropped when the
  program's input is backed up, an event is kept and tried again about 250 ms later, so the newest value
  of each topic lands. Values between may be skipped, as with any pace-limited event (at most 4 a second for
  each topic).
- **`feed` and `event` differ.** `feed` is the sample-accurate account of the audio and the tap's cursors,
  and it never names the item. `now_playing` is where a program learns which track it is: read `track_id`,
  or `track` for the row as `library.tracks` returns it.
- **Position is not streamed.** Work it out between `playback_state` events from `position_secs` and
  `position_at`, as in [following the play head](events.md#following-the-play-head). A topic named like an
  app topic that the program sends as a `page_event` reaches only the page's `onPluginEvent`.

### Sidebar items

A native plugin's sidebar items work as in the [sidebar guide](sidebar.md), with the program in the
page's place.

- A click on a `toggle` or an `action` reaches the program as `sidebar_input`. `value` is the position the
  user asked for, or `null` for an action. The click is refused, and the toggle reverts, when the program
  is not running or its frames are backed up.
- A toggle does not move by itself. It dims until the program sends its next state with
  `ui.sidebar.update`, or for 3 seconds. Confirm a click by sending the new `on`, refuse it by sending the
  old one.
- Sidebar state is kept in memory and cleared when the plugin is restarted or crashes. Send your items'
  state again after each `ready`.
- `gesture` lets the program ask `ui.confirm` or `ui.open_page` in answer to the click. Never log it.

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

A record with a new `epoch` follows a **discontinuity**: the samples before it and after it are not one
continuous signal, so flush filters, delay lines and accumulators. The rule:

- A cold start (a play, a skip, a load, a restore), a seek, or the writer resuming after it stopped opens
  a new epoch.
- A gapless successor continues the epoch its predecessor last wrote in: a new record, the **same** epoch.
  The exception is a predecessor that was not writing, for example one that produced no samples before the
  successor took over: nothing continues, so the successor opens a **new** epoch like a cold start.
- A format change keeps the epoch, with a new record: the signal continues in a new format.

Do not count on a gapless change keeping the epoch. Compare the `epoch` of each record with the last one you
saw, and flush when it differs.

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
| `cause` | string | Why the snapshot was taken: `start`, `gapless`, `pause`, `resume`, `seek`, `stop`, `volume`, `device`, `buffering`, `buffered` or `snapshot`. A `snapshot` is sent once, right after `ready`, and carries the current state; it opens no epoch. `buffering` and `buffered` are for a stream: it is waiting for audio, or has enough again and plays on in the same epoch. |
| `tap_epoch` | number | The tap's latest epoch when the snapshot was taken. |
| `tap_cursor` | number | The tap's `write_cursor` when the snapshot was taken. What the event changes reaches the ring at or after it. |
| `transport` | string | `playing`, `paused`, `stopped` or `buffering`. `buffering` is for a stream waiting for audio; nothing reaches the tap meanwhile. Treat it as not playing. |
| `sample_rate` | number | The current source's rate, `0` when stopped. |
| `channels` | number | The current source's channel count, `0` when stopped. |
| `position_secs` | number | The play head, in seconds. |
| `volume` | number | The user's volume, 0 to 1. The tap is taken before it. |
| `device` | string or null | The name of the output device Plisto renders to, null when none is open. Always null without `audio.device`. |
| `device_id` | string or null | The Windows endpoint ID of that device, null when none is open or it could not be matched. Two devices can share a name; the ID tells them apart. Always null without `audio.device`. |
| `latency_ms` | number | The device's buffer period, a good estimate of the output delay. Always sent. |
| `source` | string | What plays: `track` for a library track or a file the user opened, `stream` for a plugin's stream. |
| `live` | boolean | True for a stream with no end and no seek. Always false for a track. |

- **The first event.** Right after `ready` Plisto asks for a `snapshot`, so you know at once whether
  playback is playing, paused or stopped, without waiting for a change.
- **Loss.** Each plugin has its own bounded queue of events. If you are slow, or your input is backed up,
  events are dropped. `lost` on the next frame says how many you missed since your previous `feed`, so you
  need not work it out from the `seq` gap. In normal play it stays 0. Keep the last event you received and
  treat it as the current state. Do not depend on every event arriving.
- **Epochs.** A `start` or a `seek` is followed in the tap by a record with a new epoch; a `gapless` by a
  record in the same epoch, unless the predecessor was not writing (see "Epochs"). `tap_epoch` is the latest epoch when the event was taken, so it can still be
  the old one: the tap's records are the authority.
- **Previews.** Plisto's own previews (such as the Track Editor's) send no events and never reach the tap.
  A snapshot taken during a preview says `stopped`.

## Output takeover

A plugin that plays the sound itself, for example on another device, can ask Plisto to stop playing it
locally. Plisto then holds its own output at volume 0 and keeps everything else running: decoding, the tap,
the spectrum and the visualizers. The `volume` in `feed` events stays the user's volume. Plisto's own
previews stay audible. A plugin's stream is muted like any other sound and reaches the tap, with `source` set
to `stream` in the feed; a stream starting or ending never releases the takeover, and a release never
touches the stream.

### Asking and releasing

- Send `takeover` with `hold: true`. Plisto answers `takeover_state` with `held: true` and reason
  `granted` when the plugin holds `audio.output_takeover`, Plisto shows it as running (not starting and
  not "Not responding"), and no other plugin holds the output. Asking again while you hold it answers
  `granted` again and changes nothing.
- Otherwise the answer is `held: false` with `denied` (the capability is not granted, the plugin is not
  running, or the frame came from a run that has already ended) or `busy` (another plugin holds it), and
  nothing changes.
- Send `takeover` with `hold: false` to give it back: Plisto's speakers play again and the answer is
  `held: false`, `released`. The answer is the same when you held nothing.

No user action is needed for a grant. The user consented when they approved `audio.output_takeover` on
the review sheet at install; Plisto shows no prompt at the moment of the request.

### When Plisto takes it back

Every release, yours or Plisto's, restores Plisto's own output before anything else happens, so no later
step can leave the user in silence. Plisto takes the output back by itself in these cases, and tells a
program that is still running with `takeover_state`, `held: false` and the reason:

| `reason` | When |
| --- | --- |
| `user` | The user chose "Return to Plisto's speakers" in the Sound popover. |
| `not_responding` | Three seconds passed without a valid `pong`. |
| `stopped` | The plugin is being stopped, disabled, updated, uninstalled or restarted, or Plisto enters safe mode or exits. A process that crashed is past hearing it, but its hold ends the same way. |

A released takeover is never granted again without a fresh request. A program that recovers after
`not_responding` does not get the output back: Plisto's speakers stay on until it asks again.

The same state can arrive twice, so treat `takeover_state` as idempotent:

- A `takeover_state` your input had no room for is sent again after your next valid `pong`.
- A `not_responding` release is always sent again after your next valid `pong`, because a program that
  was hung may have missed the first one.

### Ask again on a new run

A hold lives in memory only. Nothing survives a restart of the plugin or of Plisto: a plugin that wants
the output from the start asks after each `ready`. Within one run, decide whether a revocation should end
your attempt; tap-meter asks once per run and never again after a release.

While you hold the output, the Sound popover shows that your plugin is playing the music elsewhere, with
your `status` text beside it. Keep that text meaningful while you hold it.

## Life of a native plugin

- **Install.** The folder is checked like any plugin's, and the entry must be an existing `.exe`. The
  plugin installs turned off. Nothing runs until the user reviews and enables it.
- **Enable.** Plisto checks the folder and the manifest again, then launches the process and sends
  `hello`. A plugin that does not reach `ready` in 10 seconds is killed and not started.
- **Disable, uninstall, update.** Plisto sends `shutdown`, waits 2 seconds for the process to
  exit, then kills it and whatever it started. An update stops the plugin, replaces the folder and always
  asks the user for consent again, so the program starts again only after the user approves the new version
  on the full sheet. The data directory is kept.
- **Plisto exits.** The same stop runs for every plugin in parallel, within one 2-second grace. If Plisto
  is killed instead, the job kills the plugin. Plisto exits when its process does: closing the window with
  close-to-tray on only hides it, and the program keeps running behind the tray icon.
- **Not started.** A native plugin does not start in safe mode, and does not start after an unclean exit
  until the user has chosen how to start (see [safe mode](lifecycle.md#safe-mode)). It starts at launch
  whether or not the library has tracks. If Windows refuses to run it, it does not start and is not
  retried (see [what the user sees](lifecycle.md#what-the-user-sees-on-a-plugins-row)).
- **Your process exits by itself.** That is a crash: see "Crashes and restarts".

## Logging

- Everything on standard error goes to `stderr.log` in the data directory, truncated at each launch. This
  is the log to read when the plugin will not start. Flush it, or the last lines are lost when you crash.
- `log` messages are written to `plugin.log` in the same folder, next to the page plugins' (see
  [lifecycle](lifecycle.md)). They are rate-limited: lines over the limit are dropped and counted. Text is
  cut at 2,000 characters.
- Do not log secrets or personal data, and do not log in a tight loop.

## Testing your program

You can run and test a native program without Plisto. It needs only its three arguments and pipes.

1. Write a small driver, in any language and with any test framework, that starts the program the way
   Plisto does: `--plisto-protocol 1 --plisto-data <a temporary folder> --plisto-tap none`, standard input and
   output piped, no console. The driver writes frames by hand, as in "A first session", and reads the
   program's frames from its standard output. Write the frames out in the driver rather than through your
   program's own protocol code, so the test also checks the wire format.
2. Drive the whole life: `hello` and `ready`, a `ping` and its `pong` (also while the program is busy), a
   `call` and its `result`, a `host_call` and a `host_result` you write yourself, a `shutdown` and the exit
   within 2 seconds, and standard input closed with no `shutdown`.
3. Send what the program must survive: a message type it does not know, a known type with extra fields, a
   `host_result` with an `error` object. Check that it exits on a broken frame instead of going on.
4. Check that standard output holds frames and nothing else, and that no frame is over 1 MiB.

[`examples/tap-meter`](../examples/tap-meter/README.md) shows each part:

- `tests/process.rs` is that driver, in Rust: it starts the built program with the arguments above, pipes it
  `hello`, `ping`, page calls, sidebar input, `page` and `takeover_state`, and checks the answers.
- `src/test_ring.rs` writes a tap for tests: it creates a named file mapping in layout v1 and writes samples
  and segment records the way Plisto's engine does, so a tap reader can be tested with no audio running.
- `--plisto-tap <name>` is the argument Plisto passes, so a test passes the name of a mapping it made by
  hand (the test writer's names look like `Local\tap-meter-test-<pid>-<n>`), or `none` to run with no tap, as
  a plugin without `audio.tap` does. tap-meter also accepts the same flag in its flags file, which overrides
  the name Plisto passes, to read a mapping you made while it runs inside Plisto.
- The program's test flags (`--crash-after`, `--stall`, `--takeover`) make it crash or stop answering on
  purpose, to see how Plisto supervises a plugin that misbehaves. Add flags of your own for the failures you
  want to see.

A driver proves your frames and your exits. It does not prove how Plisto treats the plugin, so end with an
install in Plisto: Developer mode, Reload from source and Open log show the result of each change (see
[install and test](install-and-test.md#developer-mode)).
