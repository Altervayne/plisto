# Streams

A plugin can hand Plisto audio and have Plisto play it: a radio station, a podcast episode, a file you fetch
and decrypt yourself, or sound a native program produces. Plisto plays it through its own player, so the
volume, the equalizer, the output device, the spectrum, the media keys and the Windows media card all work
on it. This page covers what a plugin must declare, the two ways to give Plisto bytes, the formats, the
metadata, every method with its limits, the events, every way a stream ends and what the user sees for it.

## What needs consent

Every `stream.*` method needs the `playback.stream` capability. A URL also needs `network` and the
site's origin in the manifest list; a push-only plugin needs no `network` at all.

```json
{
  "capabilities": ["playback.stream", "network"],
  "network": ["https://radio.example.com"]
}
```

On the review sheet the user reads: "Play audio streams through Plisto's player at any time, pausing your
music, with their own titles on your media keys and lock screen". With `network` also declared, the sheet
adds: "It can play audio from the sites listed above." That consent is the only gate on starting a stream.

## What a start does

Read this before you write the first `stream.play`.

- **A start needs no user action.** No click, no open page and no gesture is needed. A plugin that is
  running can start a stream at launch, on a timer, from its background page, or from a native program with
  no page open. The user sees your plugin's name on the player for as long as it plays.
- **It pauses and parks the user's music.** The user's queue is kept, not cleared. It stays editable under
  the stream. When the stream ends, the user's music comes back paused at the spot where it was parked. Plisto
  never starts it again by itself.
- **Only one stream plays in the whole app.** A second `play`, from your plugin or another one, replaces the
  first. The first owner is told: its item ends `replaced`, and every later call on that item is `not_found`.
  Any music the user starts from the library replaces the stream the same way.
- **Treat `user` and `replaced` as the user's choice.** If your stream ends with either reason, do not start
  it again. The user pressed Stop, played something else, or turned to another plugin's stream. A plugin that
  restarts after them fights the user, and the only way left to stop it is turning the plugin off.
- **A stream is not a library track.** It never enters the library, the queue, the play history or the
  play counts.

## Pull and push

**Pull** (recommended): you give Plisto a URL and Plisto fetches it. It uses the same connection rules as
`plisto.net` (see the [network guide](network.md)): consented origins only, public addresses only, no
proxy, no compression. Playback does not depend on your page staying open: if your page closes or your
native program crashes, the stream plays on.

```js
const { item } = await plisto.stream.play({
  source: { url: "https://radio.example.com/live.mp3", icy: true },
  title: "Example Radio",
  artwork: { url: "https://radio.example.com/logo.png" },
});
```

**Push**: you send the bytes with `stream.push`, at most 64 KiB per call, in the format you declared. Use it
for audio you produce, decrypt or remux yourself, and for HLS (see below). Push needs no `network`. A push
item ends `producer_gone` when the side that called `stream.play` (a page frame or the native program) goes
away; the other side going away ends nothing. Call `play` and `push` from the same side.

```js
const res = await plisto.net.fetch("https://files.example.com/track.flac", { stream: true });
const { item } = await plisto.stream.play({
  source: { push: { format: "flac" } },
  title: "Track",
  live: false,
});
await plisto.stream.pushFrom(item, res.body);
```

`plisto.stream.pushFrom(item, readable, options?)` reads a `ReadableStream` of `Uint8Array` and pushes it in
slices of at most 64 KiB. It slows down when Plisto's buffer is full and goes on when Plisto says there is room,
waits out a `rate_limited` answer, and calls `stream.end` after the last byte unless `options.end` is
`false`. It resolves `{ bytes }`, and rejects with the call's own error. If the item ends first it rejects
`not_found` and cancels the stream. To feed by hand, see "Pushing by hand" below.

## Formats

| Format | Pull (content type) | Push (`format`) |
| --- | --- | --- |
| MP3 | `audio/mpeg`, `audio/mp3` | `mp3` |
| AAC-LC in ADTS | `audio/aac`, `audio/aacp`, `audio/x-aac` | `aac_adts` |
| Ogg (Vorbis, Opus or FLAC inside), chained streams too | `audio/ogg`, `application/ogg`, `audio/opus` | `ogg` |
| FLAC | `audio/flac`, `audio/x-flac` | `flac` |
| WAV, a finite file | `audio/wav`, `audio/x-wav`, `audio/wave` | not pushable |
| MP4 or M4A (AAC, ALAC), a finite file | `audio/mp4`, `audio/x-m4a` | not pushable |
| Raw 16-bit little-endian PCM | not pullable | `pcm_s16le`, with `rate` 8000 to 192000 and `channels` 1 or 2 |

- A missing or generic content type (`application/octet-stream`) gets no hint; Plisto probes the bytes.
- HE-AAC (SBR or PS) is not promised to decode. A stream it cannot decode ends `unsupported`.
- Plisto reads no playlists. A reply of type `audio/x-mpegurl`, `audio/mpegurl`, `application/vnd.apple.mpegurl`, `application/x-mpegurl`,
  `audio/x-scpls`, `application/pls+xml`, `application/xspf+xml` or `application/dash+xml` ends the stream
  `unsupported` with detail `playlist`; a `text/*` or `application/json` reply ends it `unsupported` with
  detail `content_type`. Read the playlist yourself and give Plisto the audio URL it names.
- A server that sends ICY metadata (an `icy-metaint` header) is handled whether or not you asked for it.
  `icy: true` asks the server for it, and Plisto reads its `StreamTitle` into `now`.

### HLS

Plisto does not play HLS. To play an HLS stream, read the playlist and fetch the segments yourself with
`plisto.net`, turn them into ADTS AAC, and push them with `{ push: { format: "aac_adts" } }`. Segments
in MPEG-TS or fragmented MP4 need remuxing to ADTS first. A native program is the natural place to do this.

## Metadata

| Field | Rule |
| --- | --- |
| `title` | Required. 1 to 200 characters once cleaned. |
| `artist`, `album` | Optional. At most 200 characters once cleaned; empty reads as absent. |
| `now` | Optional. The line playing now, for a live item only; `invalid_args` with `live: false`. At most 200 characters. |
| `artwork` | Optional. `{ url }` or `{ data_b64 }`, see below. |
| `skip` | Optional. `{ next, prev }`, both default `false`. |

- Every text is cleaned before anything stores or shows it: control characters and text-direction controls
  are removed (a tab or a line break becomes a space), runs of whitespace fold to one space, and the ends are
  trimmed. The length is counted after cleaning. Over 200 is `invalid_args`; an ICY title over 200 is cut.
  It is shown as plain text, never as markup.
- Plisto shows `now` as the main line with `title` under it, and without `now` the title with the artist under
  it. The plugin's name is shown on every surface that shows the stream.
- `stream.update(item, fields)` changes any of them while playing. A `null` clears an optional field; `title`
  cannot be cleared. At least one field is needed. A change shows at once in the player, the media keys and
  the media card.
- With `icy: true` the server's `StreamTitle` becomes `now`. A server title you did not ask for is read the
  same way when the server sends one.

### Artwork

- `{ data_b64 }`: base64 of an image of at most 524,288 bytes decoded.
- `{ url }`: needs `network` and a consented origin. Plisto fetches it, at most 4 MiB, within 15 seconds.
- Both: JPEG, PNG, WebP, BMP or GIF (the first frame), at most 8,192 pixels on a side and 16,777,216 pixels
  in all. SVG fails. Plisto decodes the image and keeps its own thumbnails; the player never loads your
  file or your URL.
- Artwork that cannot be fetched or decoded is not an error: the item plays on and keeps the artwork it had.
  The arguments are checked at call time (a bad shape, a URL outside your origins), the image itself later.
- At most one artwork decode starts per 5 seconds for an item; a newer request replaces one still waiting.
  Without artwork the player shows its empty-cover look.

### Skip flags

`skip: { next: true }` says your plugin takes Next. When the user presses Next, uses the media key or
another plugin calls `playback.next`, you get a `skip` event with `direction: "next"` and nothing else
happens: you decide what plays next, usually by calling `stream.play` for the next item. A direction you
leave `false` is disabled in the player and on the media card, and its media key does nothing. Change the
flags at any time with `stream.update(item, { skip })`.

## Live and finite

- A pull item is live when the response has no `content-length` or carries an `icy-*` header; otherwise
  it is finite. Set `live` to override. If `live` is unset and the response turns out finite, a `now` you sent
  is dropped without an error.
- A push item is live by default. `live: false` means you will call `stream.end` when the bytes are done.
- A live item has no end and no seek. A finite item whose length is known and at most 128 MiB is kept whole
  as it arrives, so the user can seek in it; a seek ahead of the download waits for the bytes. A longer file plays
  forward only.
- For a finite item, the player shows a scrubber only when Plisto knows the length. Do not promise the user
  a duration, and do not wait for `duration_secs` in `stream.state`: it is always `null` today.

## Methods

Every method needs `playback.stream` and can fail with `invalid_args`, `denied`, `rate_limited`, `busy`,
`too_large` and `unavailable`, as listed under Errors. `item` is the number `stream.play` returned; it must be
your plugin's current item, or the call is `not_found`.

| Method | Helper | Arguments | Result |
| --- | --- | --- | --- |
| `stream.play` | `plisto.stream.play(args)` | `source`, `title`, optional `live`, `artist`, `album`, `now`, `artwork`, `skip` | `{ item, state: "connecting" }` |
| `stream.update` | `plisto.stream.update(item, fields)` | `item` and any of `title`, `artist`, `album`, `now`, `artwork`, `skip` | `{}` |
| `stream.push` | `plisto.stream.push(item, bytes)` | `item`, `data_b64` of 1 to 65,536 bytes | `{ buffered_ms, room }` |
| `stream.end` | `plisto.stream.end(item)` | `item`; push items only | `{}` |
| `stream.pause` | `plisto.stream.pause(item)` | `item` | `{}` |
| `stream.resume` | `plisto.stream.resume(item)` | `item` | `{}` |
| `stream.stop` | `plisto.stream.stop(item)` | `item` | `{}` |
| `stream.state` | `plisto.stream.state()` | none | see below |

`source` is exactly one of `{ url, headers?, icy? }` and `{ push: { format, rate?, channels? } }`. `url` follows
the [network guide](network.md): absolute `https` (or `http` for a developer loopback origin), no userinfo, at
most 8,192 bytes, an origin from your manifest. `headers` follow its header rules. `rate` and `channels` are for
`pcm_s16le` and required there.

`stream.play` checks the arguments, then the `network` grant and the origin of each URL, then accepts. A play
that is refused changes nothing: the user's music plays on. Everything after acceptance, such as a failed
connection or bytes that do not decode, arrives as an `ended` event, never as an error on the call. The item
starts `connecting`; the first sound comes about 1.5 seconds of audio later.

`stream.update` applies every field it carries at once. `stream.pause` and `stream.resume` pause and resume
the item as the user's play button does.

`stream.stop` ends the item `stopped`; the user's music comes back paused. `stream.end` is for push items:
no more bytes, what is buffered plays out, then the item ends `finished`. After `end`, `stream.push` is
`invalid_args`.

### `stream.state`

Arguments: none. Result, for your plugin's own item:

| Field | Meaning |
| --- | --- |
| `item` | Your current item, or `null`. |
| `state` | `connecting`, `buffering`, `playing`, `paused` or `reconnecting`; `null` with no item. |
| `live`, `seekable` | Booleans, `null` with no item. |
| `position_secs` | Listened time for a live item, the play head for a finite one. |
| `duration_secs` | Always `null` today. Do not wait for it. |
| `buffered_ms` | Decoded audio waiting to play. |
| `last_end` | `{ reason, detail }` of your previous item's end, or `null`. Kept for 60 seconds. |

It never carries a URL, a header, an origin or another plugin's data. Another plugin sees only a title, an artist
and whether the stream is live in `playback.state`, with `mine` false.

### Pushing by hand

`stream.push` answers `{ buffered_ms, room }`: the audio waiting to play, and the bytes the buffer still takes.
The buffer holds 1 MiB. When a push does not fit, the call is `busy`, nothing is written, and a `room` event
follows once at least half of it is free; push again then. A producer that keeps ahead of the player, such as
a download, can just wait for `room`. Push at the rate the audio plays, not faster: a push item that gets
no bytes for 30 seconds while it waits ends `stalled`.

```js
// Resolves at the item's next room event, or when it ends (the next push then fails not_found).
function nextRoomEvent(item) {
  return new Promise((resolve) => {
    const off = plisto.onStream((e) => {
      if (e.item === item && (e.kind === "room" || e.kind === "ended")) {
        off();
        resolve();
      }
    });
  });
}

async function feed(item, chunks) {
  for await (const chunk of chunks) {
    for (let at = 0; at < chunk.length; at += 65536) {
      for (;;) {
        try {
          await plisto.stream.push(item, chunk.subarray(at, at + 65536));
          break;
        } catch (e) {
          if (e.code !== "busy") throw e;
          await nextRoomEvent(item);
        }
      }
    }
  }
  await plisto.stream.end(item);
}
```

## Events

`plisto.onStream(callback)` subscribes to the events of your plugin's own stream and returns an unsubscribe
function. It is `plisto.onPluginEvent("stream", callback)` under another name: do not use the topic `stream` for
page events your own native program sends.

```js
plisto.onStream((e) => {
  if (e.kind === "ended" && e.item === current) {
    if (e.reason === "user" || e.reason === "replaced") return; // the user's choice
    retryLater(e.reason, e.detail);
  }
});
```

| `kind` | Fields | When |
| --- | --- | --- |
| `state` | `item`, `state` | The item's state changed: `connecting`, `buffering`, `playing`, `paused` or `reconnecting`. |
| `skip` | `item`, `direction` (`next` or `prev`) | The user asked to skip, in a direction your `skip` flags accept. |
| `room` | `item`, `room` | A push item has room again after a `busy`: `room` bytes. |
| `ended` | `item`, `reason`, `detail` | The item is over. `detail` is a fixed word or `null`. Nothing follows it. |

Where events go:

- **Every event reaches both sides of your plugin.** The page side is your newest running page frame; with
  none open, the event is dropped. The native side is your program, when it is running and ready. It gets the
  `stream` message (see the [native guide](native.md#stream-events)). This holds whichever side called `play`.
- **A native program can lose an event.** If its input is backed up, Plisto drops the event and counts it;
  it is not sent again. After a gap, or after a restart, call `stream.state` and read `last_end`: it holds the
  end of your previous item for 60 seconds.
- A plugin that is no longer running is not told that its item ended.

## When a stream ends

Every end sends one `ended` event. `detail` refines the reason. `{name}` below is your plugin's name.

| `reason` | `detail` | When | What the user sees |
| --- | --- | --- | --- |
| `user` | none | The user pressed Stop, in the player or on a media key. | The music that was parked, paused. |
| `replaced` | none | Another stream started, or the user played something else. | The new sound. |
| `stopped` | none | You called `stream.stop`. | The parked music, paused. |
| `finished` | none | A finite item reached its end, or a push item played out after `stream.end`. | The parked music, paused. |
| `plugin_gone` | `update`, `consent`, `safe_mode`, or `null` | The plugin was updated (or Plisto is about to install its own update), needs approval again, plugins are off for the session, or it was disabled, uninstalled or turned off after crashes. You are not told. | A line saying the plugin was turned off (`update`), needs approval (`consent`) or plugins are off (`safe_mode`); nothing for `null`. |
| `producer_gone` | none | The side that called `stream.play` for a push item, the page frame or the native program, went away. The other side going away ends nothing. | "{name} stopped unexpectedly, so its stream stopped." |
| `network` | `dns`, `connect`, `tls`, `protocol`, `closed`, `redirect`, `proxy`, `status` | The connection failed, or the server answered with a status other than 200 (206 for a resume). | "{name}'s stream lost its connection." |
| `denied` | `origin_not_listed`, `redirect_not_listed`, `blocked_address`, `dev_only`, or `null` | The address or a redirect was refused, at the start or at a reconnect. | "{name}'s stream points to an address Plisto does not allow." |
| `unsupported` | `content_type`, `format`, `codec`, `seek`, `decoder` | The reply is text, or the bytes do not decode, or no decoder fits, or Plisto could not start its decoder. | "Plisto cannot play the format of {name}'s stream." |
| `unsupported` | `playlist` | The reply is a playlist. | "{name} sent a playlist link instead of a stream, so Plisto cannot play it." |
| `no_audio` | none | No audio came within 20 seconds of the start. | "{name}'s stream sent no audio." |
| `stalled` | none | The item waited for more audio for 30 seconds, or Plisto's decoder stopped responding. | "{name}'s stream stopped sending audio." |

The user sees the line as a short message over the player. `user`, `replaced`, `stopped`, `finished` and a
`null` `plugin_gone` show none. When an item ends and the user had music parked, that music is back, paused;
with nothing parked, the player is empty.

What to do:

- `user`, `replaced`: stop. Do not start again.
- `finished`: start the next item, if you have one.
- `network`, `no_audio`, `stalled`: a retry after a pause is reasonable; do not loop tightly.
- `denied`, `unsupported`: retrying the same URL gives the same answer. Fix the origin list, or tell the user.
- `producer_gone`, `plugin_gone`: nothing; you were not running.

## Connection behaviour

These apply to a pull item.

| Limit | Value |
| --- | --- |
| No response headers | 15 seconds |
| No bytes while the buffer has room | 30 seconds |
| No decoded audio from the start (or a reconnect) | 20 seconds (`no_audio`) |
| Waiting for audio, in `buffering` | 30 seconds (`stalled`) |
| Reconnects of a live item | 4 in a row, after 1, 2, 4 and 8 seconds; the count resets after 60 seconds of `playing` |
| Pause hold of a live item | 60 seconds |
| Finite file kept whole, seekable | at most 128 MiB |
| Live buffer, and push buffer | 1 MiB of bytes, then 4 seconds of decoded audio |

- A live item reconnects after a dropped connection, a silent one, a 5xx answer and a `network` failure,
  showing `reconnecting` meanwhile; it never retries a `denied`, a `tls` failure or a 4xx answer. Every
  reconnect is a fresh checked request, so a withdrawn origin or developer mode switched off ends the item
  `denied`.
- **A live stream paused for more than the pause hold, 60 seconds, is closed and reconnected fresh when it
  resumes.** What was buffered before the pause is not heard, and the item shows `reconnecting` until audio
  plays again. A resume inside the hold continues the same connection. This applies to your `stream.pause`
  and to the user's pause alike.
- A finite file that stops short resumes once with a `range` request when the server sent `accept-ranges:
  bytes` and a validator; otherwise it ends `network` with detail `closed`.
- A pull item's connection shares the stream caps of `plisto.net`: 2 per plugin and 8 for the whole app. A
  `stream.play` with a URL is `busy` when the plugin already has 2 `plisto.net` streams open, or the app has 8.
- The item's own network work runs under the abort key `plisto:stream:<item>`.

## Limits

| Limit | Value |
| --- | --- |
| Title | 1 to 200 characters |
| Artist, album, now | 0 to 200 characters |
| Bytes per `stream.push` | 1 to 65,536 |
| Push buffer | 1 MiB |
| Artwork by bytes | 524,288 bytes decoded |
| Artwork by URL | 4 MiB, 15 seconds |
| Artwork image | 8,192 pixels a side, 16,777,216 pixels in all |
| Artwork decodes | one per 5 seconds per item |
| URL | 8,192 bytes |
| Rate, `stream.play`, `pause`, `resume`, `stop` | burst 4, 1 per second |
| Rate, `stream.update` | burst 10, 1 per second |
| Rate, `stream.push`, `stream.end` | burst 60, 30 per second (about 1.9 MiB a second) |
| Rate, `stream.state` | as `playback.state`: burst 20, 10 per second |
| All calls together | burst 100, 50 per second, as for every method |
| `last_end` kept | 60 seconds |
| Streams in the app | 1 playing |

## Errors

| `code` | `reason` | When |
| --- | --- | --- |
| `invalid_args` | none | Bad shape, a text over 200 characters or empty after cleaning, `now` on a finite item, `title` cleared, an empty `update`, `push` or `end` on a pull item, `push` after `end`, a `pcm_s16le` without its `rate` and `channels`, a URL that is not absolute `http` or `https`. |
| `too_large` | none | A push of more than 65,536 bytes, or artwork over 524,288 bytes. |
| `denied` | none | The plugin does not hold `playback.stream`, or a URL is used without `network`. |
| `denied` | `origin_not_listed`, `dev_only` | The URL's origin is not in the manifest, or a developer origin while developer mode is off. |
| `rate_limited` | none | A budget is empty. Retry after `retryAfterMs`. |
| `not_found` | none | `item` is not your current item: it ended, was replaced, or is another plugin's. |
| `busy` | none | A push does not fit in the buffer (wait for `room`); another `stream.play` of yours is still being accepted; or a URL play finds the stream caps full (see Connection behaviour). |
| `unavailable` | none | Your plugin is not running (disabled, updating, safe mode, held at start), or the player is gone. |

## What Plisto records

For each connection a pull item makes, Plisto adds one entry of kind `playback` to the plugin's network log:
the origin, the status or error, the bytes and the time, written when the connection ends. It never records
paths, queries or headers. Headers you set, `authorization` included, are held in memory for reconnects and
dropped when the item ends. A stream's bytes and decoded audio live in memory only and are freed when the
item ends; nothing is recorded to disk except the artwork thumbnails.

## Other things that touch a stream

- **Output takeover.** A stream plays through the same engine as the user's music. A plugin holding the
  output (see the [native guide](native.md#output-takeover)) hides it on Plisto's speakers like any other
  sound, and receives it through the tap, with `source: "stream"` in the feed. Neither releases the other.
- **Volume and sound.** The user's volume, equalizer and device apply. A plugin cannot set gain.
- **Track Editor previews.** A preview holds the stream while it sounds and the stream goes on afterwards.
- **Native programs.** A program calls the same methods with `host_call`, and receives events as `stream`
  messages. See the [native guide](native.md#stream-events).
