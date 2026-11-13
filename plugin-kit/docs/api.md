# API reference

This page lists every method a plugin can call, the error codes, the events a page receives and the
SDK's own members. Keep it open while you code. The UI methods (toast, confirm, chips, sidebar, open page)
have longer explanations in [UI surfaces](ui-surfaces.md) and the [sidebar guide](sidebar.md).

## How a call works

Your page calls `plisto.call(method, args)`, or one of the helpers that wrap it. The SDK posts a message
to Plisto, Plisto checks the call and answers with a result or an error. Every result is JSON. Every
helper returns a promise.

Plisto checks each call in this order: the plugin is enabled and running (else `unavailable`), the
plugin's overall rate budget, the method exists (else `unknown_method`), the arguments are not too large,
the plugin holds the capability the method needs (else `denied`), the method's own rate budget, and the
limit on calls in flight (else `busy`).

Limits that apply to every call:

- A method name is two to four lowercase dotted parts, such as `storage.get`. Anything else is
  `invalid_args`.
- Arguments are a JSON object, serialized to at most 262,144 characters. Beyond that the call is
  `too_large`.
- One page may have 32 calls waiting for an answer, and a plugin may have 16 in flight at once. Past that,
  calls are refused `busy`. An open toast or prompt counts as a call in flight.
- A call is answered to the page that made it. If the page closes first, the answer is dropped.
- Calls from all of a plugin's pages share the budgets below.

## Rate budgets

Each budget is a token bucket per plugin: a capacity (the burst you may make at once) and a refill rate.
Every call spends one token from the "all" budget and one from its own class. A refused call rejects with
`rate_limited` and `retryAfterMs`, the time to wait.

| Class | Used by | Capacity | Refill |
| --- | --- | --- | --- |
| all | every call | 100 | 50 per second |
| ambient | `app.info`, `app.methods` | 10 | 2 per second |
| storage read | `storage.get`, `storage.keys`, `storage.usage` | 60 | 30 per second |
| storage write | `storage.set`, `storage.remove`, `storage.clear` | 20 | 5 per second |
| log | `log.write` | 40 | 10 per second |
| toast | `ui.toast` | 3 | 1 per 10 seconds |
| confirm | `ui.confirm` | 1 | 1 per 10 seconds |
| chips | `ui.chips` | 10 | 4 per second |
| sidebar | `ui.sidebar.update` | 20 | 10 per second |
| nav | `ui.open_page` | 3 | 1 per second |

## Methods

Each entry gives the method, the capability it needs, its arguments, its result and its errors. Every
method can also fail with `rate_limited`, `busy`, `too_large` (arguments over the size limit),
`unavailable` and `invalid_args` (arguments that are not an object); these are not repeated below unless
the method has its own reason for them.

### `app.info`

Needs: nothing. Class: ambient. Helper: `plisto.app.info()`.

Arguments: none. Result:

| Field | Type | Meaning |
| --- | --- | --- |
| `api_version` | number | The API version. Currently `1`. |
| `plisto_version` | string | The running Plisto version. |
| `plugin_id` | string | Your plugin's id. |
| `plugin_version` | string | The version of your plugin that Plisto is serving. |
| `locale` | string | `"en"` or `"fr"`. |
| `theme` | string | `"light"` or `"dark"`. |
| `app_mode` | string | `"player"`, `"organizer"` or `"both"`. |
| `tier` | string | `"ui"`. |
| `granted` | string[] | The capabilities the user approved. |

The same object is what `plisto.ready` resolves with. `plisto.info` holds the latest copy.

```js
const info = await plisto.app.info();
console.log(info.locale, info.theme);
```

### `app.methods`

Needs: nothing. Class: ambient. Helper: `plisto.app.methods()`.

Arguments: none. Result: `{ api_version, methods }`, where `methods` is the sorted list of every method
name this Plisto answers.

```js
const { methods } = await plisto.app.methods();
```

For a quick check use `plisto.has(name)` instead (see Feature detection).

### `storage.get`

Needs: `storage`. Class: storage read. Helper: `plisto.storage.get(key, fallback)`.

Arguments: `{ key }`. Result: `{ found, value }`. When the key does not exist, `found` is `false` and
`value` is `null`. This is not an error. The helper returns `value` when found and your `fallback`
otherwise.

Errors: `invalid_args` (the key is not a string, is empty, is over 128 bytes or has a control character).

```js
const theme = await plisto.storage.get("theme", "auto");
```

### `storage.set`

Needs: `storage`. Class: storage write. Helper: `plisto.storage.set(key, value)`.

Arguments: `{ key, value }`. `value` is any JSON value, `null` included, and must be present. Result:
`{ usage }`, the stored size in bytes after the write.

Errors:

- `invalid_args`: bad key, or `value` is missing.
- `too_large`: the value is over 131,072 bytes once serialized, or the write would take your storage past
  the 1,048,576 byte quota. A refused write changes nothing.
- `unavailable`: the file could not be written.

```js
await plisto.storage.set("settings", { volume: 0.8, shuffle: true });
```

### `storage.remove`

Needs: `storage`. Class: storage write. Helper: `plisto.storage.remove(key)`.

Arguments: `{ key }`. Result: `{ removed, usage }`. `removed` is `false` when the key did not exist.

Errors: `invalid_args`.

### `storage.keys`

Needs: `storage`. Class: storage read. Helper: `plisto.storage.keys(prefix)`.

Arguments: `{ prefix? }`. The prefix follows the key rules except that it may be empty. Result:
`{ keys }`, the matching keys sorted in byte order.

Errors: `invalid_args` (a prefix that is not a string, is over 128 bytes or has a control character).

```js
const { keys } = await plisto.storage.keys("cache/");
```

### `storage.clear`

Needs: `storage`. Class: storage write. Helper: `plisto.storage.clear()`.

Arguments: none. Result: `{ usage }`. Removes every key.

### `storage.usage`

Needs: `storage`. Class: storage read. Helper: `plisto.storage.usage()`.

Arguments: none. Result: `{ usage, quota }`, both in bytes. The quota is 1,048,576.

Storage limits in one place:

| Limit | Value |
| --- | --- |
| Key | 1 to 128 bytes of UTF-8, no control characters |
| Value | any JSON, up to 131,072 bytes serialized |
| Total per plugin | 1,048,576 bytes |

Storage is kept per plugin and survives restarts and updates. It is removed on uninstall only if the user
ticks the box to delete it. If Plisto finds the storage file damaged, it moves it aside to `kv.json.bad`,
starts empty and notes it in your log.

### `log.write`

Needs: nothing. Class: log. Helpers: `plisto.log.debug(text)`, `.info`, `.warn`, `.error`.

Arguments: `{ level, text }`. `level` is `"debug"`, `"info"`, `"warn"` or `"error"`. `text` is a string.
Result: `{ truncated }`.

Plisto replaces line breaks and other control characters with spaces and cuts the text to 2,048 bytes
(`truncated` is then `true`). See [lifecycle](lifecycle.md) for the file and where to find it.

Errors: `invalid_args` (unknown level, or `text` is not a string), `unavailable`.

```js
plisto.log.info("sync started");
```

### `ui.toast`

Needs: `ui.toast`. Class: toast. Helper: `plisto.ui.toast(text, { action }?)`.

Arguments: `{ text, action? }`. `text` is 1 to 140 characters. `action` is the label of an optional button,
1 to 24 characters. Result, when the toast leaves the screen: `{ result: "dismissed" }` or
`{ result: "action", gesture }`.

Errors: `invalid_args` (blank text, control or invisible characters), `too_large` (over a length cap),
`busy` (too many toasts open).

Details, queueing and gestures are in [UI surfaces](ui-surfaces.md).

```js
const r = await plisto.ui.toast("Sync finished", { action: "Details" });
```

### `ui.confirm`

Needs: `ui.confirm`. Class: confirm. Helper: `plisto.ui.confirm(args)`.

Arguments: `{ title, body, confirm_label, cancel_label?, gesture? }`. `title` 1 to 60 characters, `body` 1
to 300, `confirm_label` and `cancel_label` 1 to 24. `gesture` is a token from a recent click (at most 64
bytes). Result: `{ answer }` where `answer` is a boolean. The helper resolves `true` or `false`.

Errors: `invalid_args`, `too_large`, `busy` (you already have a prompt open, or too many are open),
`denied` with `reason: "no_gesture"` (see the prompt gate), `timeout` (nobody answered in 5 minutes).

```js
const yes = await plisto.ui.confirm({ title: "Delete cache?", body: "This frees 2 GB.", confirm_label: "Delete" });
```

### `ui.chips`

Needs: `ui.chips`. Class: chips. Helper: `plisto.ui.chips(chips)`.

Arguments: `{ chips }`, an array of at most 2 chips. Each chip has exactly one of `text` (1 to 12
characters) or `count` (an integer from 0 to 2147483647), and an optional `tone` of `"neutral"` (the
default), `"accent"` or `"warn"`. An empty array clears the chips. Result: `{}`.

Errors: `invalid_args` (both or neither of `text` and `count`, a bad tone, blank text), `too_large` (more
than 2 chips, text over 12 characters).

```js
await plisto.ui.chips([{ text: "3 devices" }, { count: 2, tone: "accent" }]);
```

### `ui.sidebar.update`

Needs: `ui.sidebar`. Class: sidebar. Helper: `plisto.ui.sidebar.update(itemId, state)`.

Arguments: `{ item_id, state }`. `item_id` is the id of an item declared in your manifest. `state` fits
that item's type; every update replaces the whole state. Result: `{}`.

Errors: `not_found` (the item is not declared, or the manifest has no sidebar block), `invalid_args` (the
state does not fit the item), `too_large` (text over its cap).

The state shapes are in the [sidebar guide](sidebar.md).

```js
await plisto.ui.sidebar.update("sync", { text: "Synced", tone: "neutral" });
```

### `ui.open_page`

Needs: nothing. Class: nav. Helper: `plisto.ui.openPage(route?, gesture?)`.

Arguments: `{ route?, gesture? }`. `route` is `null` (the page's start) or 1 to 64 visible ASCII
characters. `gesture` is a token from a recent click. Result: `{}`.

Errors: `invalid_args` (bad route or gesture), `denied` with `reason: "no_gesture"`.

It opens your own page only. Plisto may still not show it, for example when the current app mode hides
the plugin; the call does not say. See [UI surfaces](ui-surfaces.md).

```js
await plisto.ui.openPage("settings");
```

## Error codes

Every failure rejects with a `PlistoError` whose `code` is one of nine values:

| Code | Meaning |
| --- | --- |
| `denied` | The plugin does not hold the capability the method needs, or a prompt or page-open call had no open page and no valid gesture (then `reason` is `"no_gesture"`). |
| `rate_limited` | A budget is empty. `retryAfterMs` says when to retry. |
| `invalid_args` | The arguments are malformed: wrong type, missing field, a key or text that breaks the rules, an unknown level, a state that does not fit its item, a method name that is not valid. |
| `too_large` | The arguments, a value, a text or the storage quota is over its limit, or more than 2 chips. |
| `not_found` | The target does not exist, for example a sidebar item the manifest does not declare. |
| `unknown_method` | This version of Plisto does not have the method. |
| `busy` | Too many calls are waiting, or a prompt or toast slot is taken. |
| `timeout` | No answer within the call's timeout (raised by the SDK), or the user did not answer a prompt in 5 minutes (raised by Plisto). |
| `unavailable` | Plisto cannot serve the plugin right now: it is disabled, updating or broken, or the call could not be delivered. |

`reason` is `null` except for `denied` with `"no_gesture"`. Branch on `code`. Use `reason` to tell a missing
gesture from a missing capability.

```js
try {
  await plisto.storage.set("k", 1);
} catch (e) {
  if (e.code === "rate_limited") setTimeout(retry, e.retryAfterMs);
  else plisto.log.error("storage failed: " + e.code);
}
```

Messages on errors are fixed English text meant for you, not for display to the user.

## Feature detection

`plisto.has(name)` is `true` when Plisto listed the method at start, and `false` before `plisto.ready`
resolves. Use it, or catch `unknown_method`, before relying on a method an older Plisto may lack.

```js
await plisto.ready;
if (plisto.has("ui.toast")) { /* safe to call */ }
```

`has` says only that the method exists. It does not say that the plugin holds the capability. Check
`info.granted` for that, or catch `denied`.

Methods for library data, playback and audio are not in this version of the API. They answer
`unknown_method`.

## Events

Plisto posts messages to your page; the SDK turns them into events. Subscribe with `plisto.on(event,
callback)`, which returns a function that unsubscribes.

| Event | Callback value | When |
| --- | --- | --- |
| `theme` | `"light"` or `"dark"` | The app theme changed. The SDK has already updated `data-theme` on `<html>`. |
| `visibility` | `true` or `false` | The plugin's page was shown or hidden. |
| `route` | string or `null` | The page's route changed. `plisto.route` is already updated when the callback runs. |
| `sidebar` | `{ item_id, value, gesture }` | The user clicked a toggle or action item of your sidebar section. `value` is the position the user asked for, or `null` for an action. |

Notes:

- `route` is meaningful only while `plisto.pageOpen` is true. A closed page does not hear route changes.
- The `sidebar` event reaches your page only after it has initialised. A click while your page is not
  running is dropped and never replayed.
- A callback that throws does not stop other callbacks.
- Your page cannot send these messages to Plisto.

```js
plisto.on("theme", (theme) => console.log("theme is now " + theme));
plisto.on("sidebar", ({ item_id, value, gesture }) => { /* see the sidebar guide */ });
```

## The SDK

`plisto-sdk.js` defines `window.plisto` and answers Plisto's heartbeat from the moment it loads. Its
version is `plisto.sdkVersion` (`1.1.0`).

| Member | Meaning |
| --- | --- |
| `sdkVersion` | The SDK version string. |
| `ready` | Promise that resolves with the app info once Plisto has initialised the page. |
| `info` | The latest app info, or `null` before `ready`. |
| `pageOpen` | `true` while the plugin's page is on screen. `false` before `ready`. |
| `route` | The page's current route, or `null`. |
| `call(method, args?, { timeoutMs }?)` | Calls any method. Resolves with the result, rejects with `PlistoError`. |
| `has(method)` | Whether Plisto listed the method at start. |
| `on(event, callback)` | Subscribes to an event. Returns an unsubscribe function. Throws `TypeError` for an unknown event. |
| `app.info()`, `app.methods()` | Helpers for `app.info` and `app.methods`. |
| `storage.get/set/remove/keys/clear/usage` | Helpers for the `storage.*` methods. |
| `log.debug/info/warn/error` | Helpers for `log.write`. |
| `ui.toast/confirm/chips/openPage` | Helpers for the UI methods. |
| `ui.sidebar.update(itemId, state)` | Helper for `ui.sidebar.update`. |
| `PlistoError` | The error class. |

Details:

- **Timeouts.** A call times out after 10 seconds unless you pass `timeoutMs` (1 to 600000). A result that
  arrives later is dropped. `ui.toast` waits up to 70 seconds and `ui.confirm` up to 310 seconds, longer
  than Plisto's own deadlines, so Plisto answers first.
- **Arguments.** `call` takes an object. Leaving it out sends `{}`. Arguments that cannot be turned into
  JSON reject with `invalid_args`.
- **`PlistoError`.** It extends `Error`. Fields: `code`, `message`, `retryAfterMs` (a number for
  `rate_limited`, else `null`) and `reason` (a string or `null`).
- **Theme and language.** At start the SDK sets `data-theme` on `<html>` from `info.theme` and `lang`
  from `info.locale`.
- **Types.** `sdk/plisto-sdk.d.ts` types `window.plisto` and every `call`. Include it in a TypeScript
  project. A call to a method the types do not know still works and returns `unknown`.

```js
const result = await plisto.call("storage.get", { key: "count" }, { timeoutMs: 3000 });
```
