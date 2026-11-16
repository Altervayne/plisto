# Limits

Every number a plugin author meets, in one place. Each table links the page that explains the rule.

## Calls

| Limit | Value | More |
| --- | --- | --- |
| Method name | 2 to 4 lowercase dotted parts, at most 64 characters | [API](api.md#how-a-call-works) |
| Arguments of a page's call | 262,144 characters of JSON (`too_large` beyond) | [API](api.md#how-a-call-works) |
| Arguments of a native program's `host_call` | 1,048,576 bytes (`too_large` beyond) | [API](api.md#how-a-call-works) |
| Calls waiting, one page | 32 (`busy` beyond) | [API](api.md#how-a-call-works) |
| Calls in flight, one plugin | 16 (`busy` beyond). An open toast or prompt counts as one. | [API](api.md#how-a-call-works) |
| SDK call timeout | 10 seconds, or `timeoutMs` from 1 to 600,000 | [API](api.md#the-sdk) |
| Request body of `net.fetch` | 1 MiB | [network](network.md#limits) |
| Error codes | 12 | [API](api.md#error-codes) |

## Rates

Each is a burst, then a refill. A call refused rejects `rate_limited` with `retryAfterMs`. Every method call
also spends one token of the "all" bucket.

| Class | Burst | Then | More |
| --- | --- | --- | --- |
| All calls | 100 | 50 per second | [API](api.md#rate-budgets) |
| `app.info`, `app.methods`, `events.subscribe` | 10 | 2 per second | [API](api.md#rate-budgets) |
| Storage reads | 60 | 30 per second | [API](api.md#rate-budgets) |
| Storage writes | 20 | 5 per second | [API](api.md#rate-budgets) |
| `log.write`, and a native program's `log` messages (one shared bucket) | 40 | 10 per second | [lifecycle](lifecycle.md#logging) |
| `ui.toast` | 3 | 1 per 10 seconds | [UI surfaces](ui-surfaces.md#toasts) |
| `ui.confirm` | 1 | 1 per 10 seconds | [UI surfaces](ui-surfaces.md#prompts) |
| `ui.chips` | 10 | 4 per second | [UI surfaces](ui-surfaces.md#chips) |
| `ui.sidebar.update` | 20 | 10 per second | [sidebar](sidebar.md#updating-items-live) |
| Sidebar clicks (not a method, no "all" token) | 5 | 5 per second | [sidebar](sidebar.md#receiving-clicks) |
| `ui.open_page` | 3 | 1 per second | [UI surfaces](ui-surfaces.md#opening-your-page) |
| `library.*` except `cover` | 60 | 30 per second | [API](api.md#rate-budgets) |
| `library.cover` | 30 | 10 per second | [API](api.md#rate-budgets) |
| `playback.state`, `playback.queue`, `stream.state` | 20 | 10 per second | [API](api.md#rate-budgets) |
| Other `playback.*`, `queue.*` | 10 | 5 per second | [API](api.md#rate-budgets) |
| `stream.play`, `pause`, `resume`, `stop` | 4 | 1 per second | [stream](stream.md#limits) |
| `stream.update` | 10 | 1 per second | [stream](stream.md#limits) |
| `stream.push`, `stream.end` | 60 | 30 per second | [stream](stream.md#limits) |
| `net.fetch`, `net.socket.open` | 30 | 10 per second | [network](network.md#limits) |
| Socket send and close, abort, stream cancel | 40 | 20 per second | [network](network.md#limits) |
| `net.stream.ack` | 40 | 20 per second | [network](network.md#limits) |
| `plugin.*` relay | 40 | 20 per second | [native](native.md#calls-from-the-page) |
| A native program's `page_event` (not a method) | 20 | 20 per second | [native](native.md#page-events) |
| App events, each topic and side | 1 at once | 4 per second | [events](events.md#how-often-events-arrive) |

## The native protocol

| Limit | Value | More |
| --- | --- | --- |
| Frame body, either direction | 1 MiB (1,048,576 bytes) | [native](native.md#frame-format) |
| Frame length field | 1 to 7 decimal digits | [native](native.md#frame-format) |
| Time to answer `hello` with `ready` | 10 seconds | [native](native.md#the-handshake) |
| `ping` | Every 1 second. 3 seconds without a valid `pong` shows Not responding. | [native](native.md#the-ping-rule) |
| Time to exit after `shutdown` | 2 seconds, then the process and its children are killed | [native](native.md#exit) |
| Restart after a crash | After 1, then 2, then 4 seconds. 3 crashes within 60 seconds turn the plugin off. A run of 60 seconds is stable. | [native](native.md#crashes-and-restarts) |
| Answer to a relayed `call` | 10 seconds (`timeout`). The SDK waits 12. | [native](native.md#calls-from-the-page) |
| Calls in flight, plugin-wide | 16 (`busy` beyond), shared by the page's calls, relayed calls and the program's `host_call`s | [native](native.md#calling-the-api) |
| `status` | At most 1 applied per second. Text 1 to 60 characters after trimming. | [native](native.md#status) |
| `page_event` | 32 KiB, topic and data together | [native](native.md#page-events) |
| `stream.push` bytes | 65,536 decoded (about 87 KB of base64) | [native](native.md#stream-events) |
| `events.subscribe` topics | 16 | [events](events.md#limits) |
| Frames waiting to be written to the program | 64 | below |
| Frames waiting to be read by Plisto | 64. When that inbox is full, Plisto stops reading and the program blocks on its own write until there is room. | this page |
| Protocol errors written to Plisto's own diagnostic output | The first 16 of each run. The rest are only counted. Neither reaches `plugin.log` or `stderr.log`. | below |

### When the program's input is backed up

Plisto never waits for a program that stops reading. Each plugin has a queue of 64 outgoing frames. When it
is full, what happens depends on the kind of frame:

| Frame | What Plisto does |
| --- | --- |
| `feed` | Drops it. The next `feed` says in `lost` how many were missed. |
| `stream` | Drops it and counts it. It is not sent again, and the program is not told. Read `stream.state` after a gap. |
| `event` | Keeps it and tries again once its pace gap (250 ms) has passed, so the newest value of each topic lands. |
| `call` (from the page) | Answers the page `busy`. |
| `sidebar_input` | Refuses the click. It never reaches the program. |
| `takeover_state` | Owes it, and sends it again after the next valid `pong`. |
| `host_result` | Drops it and counts it. The program's call is never answered, so give every `host_call` a deadline. |
| `ping`, `page` | Drops it. A lost `ping` reads as silence. A lost `page` is not sent again. |

A frame over 1 MiB is never queued: a `host_result` that does not fit is replaced by a `too_large` error,
and a page call with arguments that do not fit is answered `too_large`.

## Logs

| Limit | Value | More |
| --- | --- | --- |
| A page's `log.write` text | Cut to 2,048 bytes, at a character boundary | [lifecycle](lifecycle.md#logging) |
| A program's `log` text | Cut to 2,000 characters first, then to 2,048 bytes | [native](native.md#logging) |
| Log rate | One bucket per plugin: burst 40, then 10 per second, shared by `log.write` and a program's `log`. A line over it is dropped and counted. | [lifecycle](lifecycle.md#logging) |
| `plugin.log` | Renamed to `plugin.log.1` at 262,144 bytes, replacing the older copy | [lifecycle](lifecycle.md#logging) |
| `stderr.log` | Truncated at each launch | [native](native.md#logging) |
| Developer log panel | The last 200 lines, from at most the last 64 KiB of each file | [install and test](install-and-test.md#developer-mode) |

## The sidebar and UI surfaces

| Limit | Value | More |
| --- | --- | --- |
| Sidebar items | 1 to 6. Item id 1 to 32 characters. Label 1 to 24. Route 1 to 64. | [sidebar](sidebar.md#the-declaration) |
| Status text, progress text | Up to 40 characters | [sidebar](sidebar.md#updating-items-live) |
| Sidebar draws | One change per item every half second, and an appearance change every 2 seconds | [sidebar](sidebar.md#updating-items-live) |
| Toggle waits for its state | 3 seconds | [sidebar](sidebar.md#receiving-clicks) |
| Toast | Text 140, action 24 characters. 4 open across plugins. Shown about 4 seconds, dismissed after 60. | [UI surfaces](ui-surfaces.md#toasts) |
| Prompt | Title 60, body 300, labels 24 characters. 1 open per plugin and 4 across plugins. Times out at 5 minutes. | [UI surfaces](ui-surfaces.md#prompts) |
| Chips | 2, each text up to 12 characters | [UI surfaces](ui-surfaces.md#chips) |
| Gesture | Single use, valid 5 seconds | [UI surfaces](ui-surfaces.md#the-prompt-gate-and-gestures) |

## Storage and library reads

| Limit | Value | More |
| --- | --- | --- |
| Storage key | 1 to 128 bytes of UTF-8 | [API](api.md#storagekeys) |
| Storage value | 131,072 bytes serialized | [API](api.md#storageset) |
| Storage per plugin | 1,048,576 bytes | [API](api.md#storageusage) |
| Library page | `limit` 1 to 200, default 50 | [API](api.md#paging) |
| `library.tracks_by_id` | 200 ids | [API](api.md#librarytracks_by_id) |
| `library.cover` | An image of at most 262,144 bytes | [API](api.md#librarycover) |
| `queue.*` `track_ids` | 500 | [API](api.md#queueplay-queueadd-queueplay_next) |

## Install

| Limit | Value | More |
| --- | --- | --- |
| `plugin.json` | 64 KiB | [manifest](manifest.md#rules-for-the-file) |
| `name` / `author` / `native_reason` / `homepage` | 40 / 80 / 280 / 200 characters | [manifest](manifest.md#fields) |
| `id` | 3 to 64 characters | [manifest](manifest.md#id) |
| A path in the manifest | 128 characters | [manifest](manifest.md#paths) |
| Network origins | 8, each at most 128 characters | [manifest](manifest.md#fields) |
| Icon | 256 KiB. A PNG at least 64 by 64 pixels. | [manifest](manifest.md#icon) |
| Files in a plugin | 4,096 | [lifecycle](lifecycle.md#install) |
| Total size | 256 MiB, archive included | [lifecycle](lifecycle.md#install) |
| Folder depth | 16 | [lifecycle](lifecycle.md#install) |
| A path | 200 characters, and 240 once installed | [lifecycle](lifecycle.md#install) |
| A file served to the page | 8 MiB, one of 16 extensions | [UI surfaces](ui-surfaces.md#files-plisto-serves) |

## The page frame

| Limit | Value | More |
| --- | --- | --- |
| Heartbeat | A ping every second. Not responding after about 5 seconds, stopped after about 15. | [lifecycle](lifecycle.md#the-heartbeat) |
| Background plugins | Started one at a time, a couple of seconds apart | [lifecycle](lifecycle.md#background-plugins) |

## Streams

| Limit | Value | More |
| --- | --- | --- |
| Title | 1 to 200 characters. Artist, album and now 0 to 200. | [stream](stream.md#limits) |
| Bytes per `stream.push` | 1 to 65,536 | [stream](stream.md#limits) |
| Push buffer | 1 MiB | [stream](stream.md#limits) |
| Artwork by bytes | 524,288 bytes decoded | [stream](stream.md#limits) |
| Artwork by URL | 4 MiB, 15 seconds | [stream](stream.md#limits) |
| Streams in the app | 1 playing | [stream](stream.md#limits) |
| `last_end` kept | 60 seconds | [stream](stream.md#limits) |

## Network

| Limit | Value | More |
| --- | --- | --- |
| Buffered response | 8 MiB | [network](network.md#limits) |
| Fetches in progress | 4 per plugin, 12 in the app | [network](network.md#limits) |
| Streams open | 2 per plugin, 8 in the app | [network](network.md#limits) |
| Sockets open | 2 per plugin, 8 in the app | [network](network.md#limits) |
| URL | 8,192 bytes | [network](network.md#limits) |
| Connect timeout | 10 seconds | [network](network.md#limits) |
| Socket send | 64 KiB, 16 queued | [network](network.md#sockets) |
| Incoming socket message | 1 MiB. At most 100 messages and 4 MiB per second. | [network](network.md#sockets) |

## The audio tap

| Limit | Value | More |
| --- | --- | --- |
| Mapping size | 4,198,400 bytes (4,096 header, then 4 x 1,048,576) | [native](native.md#opening-it) |
| Sample ring | 1,048,576 samples | [native](native.md#layout-v1) |
| Segment records | 64, of 24 bytes | [native](native.md#layout-v1) |
| Writer guard | 2,048 samples past `write_cursor` | [native](native.md#overruns) |
