# App events

Plisto tells a plugin when something it shows changes: what is playing, the transport, the queue, the library,
the theme, the language and the app mode. A plugin subscribes to the topics it wants and gets each change as
an event, instead of asking again and again. This page covers what a subscription needs, every topic with
its payload and what makes it fire, how often events arrive, how to follow the play head without polling, the
rules of `library_changed`, where events go and what ends a subscription.

## What needs consent

Subscribing takes no capability of its own. Each topic needs what reading the same thing needs:

| Topic | Needs |
| --- | --- |
| `now_playing`, `playback_state`, `queue` | `playback.read` |
| `library_changed` | `library.read` |
| `theme`, `locale`, `app_mode` | nothing |

The grant is checked when you subscribe and again before every delivery. A plugin that lost a grant, or
that Plisto no longer serves, stops hearing the topic without an error.

## Subscribing

`plisto.events.subscribe(topics)` takes an array of topic names and resolves `{ topics, current }`.
`plisto.events.on(topic, callback)` registers a handler and returns an unsubscribe function. It does not
subscribe: it only says what to do with an event that arrives. `plisto.events.topics()` resolves the names
this Plisto offers, from `app.methods`; it is empty on a Plisto that has no events.

```js
plisto.events.on("playback_state", (state) => draw(state));
plisto.events.on("locale", ({ locale }) => setLanguage(locale));
const { topics, current } = await plisto.events.subscribe(["playback_state", "locale"]);
```

- **A subscribe replaces your whole set.** To add a topic, send the full list you want. `topics: []` clears
  the set. There is no separate unsubscribe.
- **`topics` in the answer** is the accepted set, sorted. **`current`** holds the current value of every
  accepted topic but `library_changed`, which only reports changes. A topic whose value could not be read
  at that moment is left out; its next event carries it.
- **`current` reaches your handlers first.** The SDK passes each value in `current` to the `events.on`
  handlers of its topic before the promise resolves, so register handlers before you subscribe and one code
  path draws both the first value and every change. A topic with no handler is dropped.
- **Subscribing twice in a row is safe.** Both calls get their answer, in the order you issued them, and
  the last one Plisto accepted decides what you hear: a refused subscribe changes nothing. An event that
  happens while a subscribe is in flight is held, only the latest for each topic, and delivered after its
  answer. An event older than the answer is never delivered after it.
- **A page starts with no subscription.** A page that is reloaded, closed and opened again, or restarted,
  subscribes again after `plisto.ready`.
- **No event is replayed.** Whatever happened before you subscribed is in `current`, or not at all.

Errors:

| `code` | When |
| --- | --- |
| `invalid_args` | `topics` is not an array of strings, holds more than 16, names an unknown topic, or names `stream`, which is reserved (see Streams). |
| `denied` | A topic needs a capability the plugin does not hold. The message names the topic, and the previous set stays. |
| `rate_limited` | The ambient budget is empty: burst 10, then 2 per second, shared with `app.info` and `app.methods`. |
| `unavailable` | The plugin is not being served right now. |
| `unknown_method` | This Plisto has no events. |

A refused call changes nothing.

## Topics

### `now_playing`

Needs `playback.read`. The item that is seated: a library track, a file the user opened, a plugin stream, or
nothing.

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | string or `null` | `"library"`, `"file"` (an item opened straight from a file, not in the library), `"stream"`, or `null` when nothing is seated. |
| `track_id` | number or `null` | The library track's id; `null` for any other source. |
| `track` | track or `null` | The track as `library.tracks` gives it, the same object `playback.state` returns. `null` unless `source` is `"library"`, and for a library track missing on disk (its id is still in `track_id`). |
| `stream` | object or `null` | `{ title, artist, live, mine }` for a seated stream, whoever owns it, else `null`. It can be `null` for a moment while `source` is `"stream"`: handle it. |

It fires when the seated item changes, when a seated stream's title or artist changes, and when the playing
library track's own row changes, such as the user editing its title. For an opened file and for a stream the
payload carries no identity, so two in a row can be equal: an event still arrives for each. The same library
track twice in a row is one item to this topic and fires once: watch `start_seq` in `playback_state` to hear
each start.

### `playback_state`

Needs `playback.read`. The transport and everything about it except where the play head is going.

| Field | Type | Meaning |
| --- | --- | --- |
| `transport` | string | `"playing"`, `"paused"`, `"stopped"` (nothing seated) or `"buffering"`. A stream that is connecting, buffering or reconnecting reads `buffering`. |
| `position_secs` | number | The play head when Plisto read it, in seconds. For a live stream, the time listened. |
| `position_at` | number | When Plisto composed the event, in Unix milliseconds on this machine's clock. `position_secs` can be up to about 33 ms older than the stamp. |
| `duration_secs` | number | The item's length in seconds; `0` when unknown, and for a live stream. |
| `start_seq` | number | Rises when an item starts, cold or gaplessly, or is loaded, a repeat-one restart and a stream's reattach included. |
| `seek_seq` | number | Rises on a seek that took effect: from the user, the media keys or a plugin's `playback.seek`. A device change does not move it. |
| `repeat` | string | `"off"`, `"all"` or `"one"`. |
| `shuffle` | boolean | |
| `volume` | number | 0 to 1. A volume drag fires events, held to the pace below. |
| `stream` | object or `null` | `{ phase, live, seekable }` for a seated stream, `phase` one of `connecting`, `buffering`, `playing` or `paused`. |

It fires when any field but `position_secs` and `position_at` changes. **A position tick fires nothing.**
`start_seq` and `seek_seq` both start at 0 each time Plisto starts: compare them with the last values you
saw, and never read them as counts of anything. For a stream, `seek_seq` moves only on a seek of a finite,
seekable item.

### `queue`

Needs `playback.read`.

| Field | Type | Meaning |
| --- | --- | --- |
| `index` | number | The current item's place in the queue. |
| `length` | number | |
| `rev` | number | Changes whenever the queue may have changed: it rises on every queue report while anyone listens, a replay of an identical list included, and once when the last `queue` listener leaves. Compare it for inequality; never read the value or the size of a step. |
| `parked` | boolean | `true` while a stream is seated over the user's queue. |

The event carries no ids, so it stays small: read them with `playback.queue` when `rev` changed. It fires on
a change of contents or order, of `index` or `length`, or of `parked`. A `rev` you saw before a gap in your
subscription says nothing about the gap: read the queue again after you subscribe.

### `library_changed`

Needs `library.read`. It reports changes only, so it has no `current`.

| Field | Type | Meaning |
| --- | --- | --- |
| `track_ids` | number[] or `null` | The ids of the tracks that changed or were removed, sorted, at most 500. `null` means many or unknown. |
| `albums` | boolean | An album, a single or an album's members changed. |
| `playlists` | boolean | A playlist, or the tracks in one, changed. |

The rules:

- **`null` means read again. It does not mean something changed.** A full reload of Plisto's track list sends
  `track_ids: null` even when nothing changed: at start, after a quiet rescan, after a manual refresh. Treat
  it as "refresh what you show".
- **An id that no longer exists** returns nothing from `library.tracks_by_id`: a removed track is reported
  by its id, and your next read finds it gone.
- **A member of an album or a playlist** changes what `library.tracks_by_id` returns for it (a track in an
  album shows the album's title, artist and year), so the event lists the member ids and sets `albums` or
  `playlists`.
- **It carries ids and scopes, never titles.** Read the rows you care about.
- **An edit may report twice:** when Plisto shows it, and again once it is saved. Read after the last event
  of a burst, for example once nothing has arrived for a moment, so you get the saved rows.
- **Events inside one window merge.** The ids are united (past 500 they become `null`) and `albums` and
  `playlists` are ORed, so one `library_changed` can stand for several edits. A report that was on its
  way when you subscribed, for any set of topics, can be lost: read again after every subscribe.
- Writes that replace no row, such as setting or clearing a cover and renaming a genre, report once the
  write has succeeded.

### `theme`, `locale`, `app_mode`

No capability. Each carries the resolved value, the one `app.info` reports:

| Topic | Payload | Fires when |
| --- | --- | --- |
| `theme` | `{ theme }`, `"light"` or `"dark"` | The theme changes, by the user's setting or by the system when they follow it. |
| `locale` | `{ locale }`, `"en"` or `"fr"` | The language changes. |
| `app_mode` | `{ app_mode }`, `"player"`, `"organizer"` or `"both"` | The app mode changes. |

`theme` is for your page's logic. The SDK does not restyle from it: `data-theme` on `<html>` keeps following
`plisto.on("theme")`.

## How often events arrive

- **At most 4 deliveries a second for each topic.** The first value goes out at once when the topic was quiet
  for 250 milliseconds. Values that come inside the window wait, and the newest goes out when it ends. **The
  last value always lands.** A pause, a skip or a seek reaches you within a quarter second.
- **A value you already hold is not sent again.** A subscribe's `current` counts as held, and for
  `playback_state` the position is left out of the comparison.
- **`library_changed` merges inside a window** (see its rules), where the other topics keep the newest value.
- Events are small: the largest is a track. They stay far inside a native program's 1 MiB frame.

## Following the play head

Plisto never streams the position. Each `playback_state` carries the position at the moment of the change
with a clock stamp, and a plugin works out the rest. The pair is accurate to within a few tens of
milliseconds: the stamp is taken when Plisto composes the event, the position can be up to about 33
milliseconds older, and the output device's latency is not corrected. `playback.state` reads the same
snapshot, so it is no more exact; call it for a fresh value between events. A native program that needs
sample accuracy uses the audio feed (see the [native guide](native.md#the-feed)).

```js
let last = null; // the newest playback_state

function position() {
  if (!last) return 0;
  if (last.transport !== "playing") return last.position_secs;
  return last.position_secs + (Date.now() - last.position_at) / 1000;
}

plisto.events.on("playback_state", (state) => {
  const was = last;
  last = state;
  if (was && state.start_seq !== was.start_seq) onItemStarted(); // a new item, or a restart
  else if (was && state.seek_seq !== was.seek_seq) onSeek(position());
  else onTransport(state.transport, position());
});
await plisto.events.subscribe(["playback_state"]);
```

- `start_seq` moving says a new item started or the same one restarted. `now_playing` says which item.
- `seek_seq` moving says the play head jumped. Coalescing can merge two events, but it never hides a seek:
  the last value always carries the newest counters.
- A pause, a resume, a skip and a volume change change no counter: read `transport` and the position.
- `position_at` is this machine's clock. To pass a position to another machine, send `position_secs` and
  how old it is, `Date.now() - position_at`, not the stamp.
- Between events the play head moves at normal speed while `transport` is `playing`, which is what
  `position()` assumes. A stall that comes back as `buffering` is an event.

## Streams

A plugin stream is reported as `playback.state` reports it, to every subscriber:

| Seated | `now_playing` | `playback_state` | `queue` |
| --- | --- | --- | --- |
| Your own stream | `source: "stream"`, `track_id` and `track` `null`, `stream.mine: true` | `stream` holds its phase, `live` and `seekable` | The user's queue, with `parked: true`. |
| Another plugin's stream | The same, with `mine: false`. | The same. | The same. |

- No event carries an item id, a URL, a header, an origin, the owner's name, `now`, an album or artwork.
  Title and artist are the cleaned pair `playback.state` returns.
- The owner still hears its own stream's events on `plisto.onStream`, the topic `stream` of
  `onPluginEvent`. That channel is never subscribed, and `plisto.events.on("stream", ...)` throws.
  `events.subscribe` refuses the name `stream` with `invalid_args`.

## Where events go

- **A page.** Events go to the plugin's newest running page that subscribed, and only to a page whose own
  subscribe accepted the topic: a reloaded page inherits nothing. A background plugin's page is the same
  page that stays alive while another page shows. While Plisto's window is hidden or minimized the page may
  hear events late, as every timer in it runs slow (see [lifecycle](lifecycle.md#background-plugins)).
- **A native program.** It subscribes with `host_call` and gets `event` messages, whether or not its page is
  open and with the window hidden to the tray. See the [native guide](native.md#app-events).
- **A native plugin's page and its program subscribe separately.** Each has its own set, and both receive.
- The topic names are Plisto's. A `page_event` your program sends with a topic named `theme` or `queue`
  reaches only `plisto.onPluginEvent`, never `events.on`.

## What ends a subscription

| What happens | What is cleared |
| --- | --- |
| The page is closed, reloaded, restarted or crashes | The page's set. |
| The program's run ends: a crash, a restart, a stop | The program's set. It subscribes again after `ready`. |
| The plugin is disabled, uninstalled, updated, needs approval again or Plisto enters safe mode | Both sets. |
| The plugin loses the grant behind a topic | That topic. |
| A subscribe | The caller's side is replaced. |

Safe mode and a plugin held at start serve nothing, so a subscribe is `unavailable` and no event is
composed. With no subscriber at all, Plisto composes nothing.

## Limits

| Limit | Value |
| --- | --- |
| Topics in one subscribe | 16 |
| Deliveries for each topic, each side | 4 a second |
| `library_changed.track_ids` | 500, then `null` |
| Rate, `events.subscribe` | burst 10, 2 a second (the ambient budget) |
