# The page bridge

This page lists the messages a plugin page and Plisto exchange with `postMessage`. You do not need it if your
page loads `plisto-sdk.js`: the SDK sends and reads every message below for you. Read it when you cannot use
the SDK, for example when you write the page layer in another language or framework, or when you debug
what crosses the frame. The SDK's own code, `sdk/plisto-sdk.js`, is the working reference.

## The rules of the channel

- Every message is a plain object with `plisto: 1` and a string `type` that starts with `plisto:`. The `1` is
  the bridge protocol version.
- Send to Plisto with `window.parent.postMessage(message, "*")`. The target origin is `"*"` because a
  sandboxed page has an opaque origin.
- Receive on `window` with a `message` event. Accept an event only when `event.source === window.parent` and
  `data.plisto === 1`. Ignore a `type` you do not know: later versions add types.
- Plisto reads your message by own data properties only. It drops a message from an origin other than the
  frame's, a message that is not a plain object (an array, a class instance, an object with accessors) and
  one whose `plisto` is not `1`. A dropped message gets no answer, so put a timeout on every call.
- Register your listener when your script loads, before the page finishes parsing. Plisto starts pinging
  as soon as the frame loads and counts silence as a crash (see the [heartbeat](lifecycle.md#the-heartbeat)).
  A page that loads a new document, a reload included, is counted as crashed.

The order of a page's life is: Plisto pings, sends `plisto:init` once, then your page calls and Plisto
answers, and the notifications below arrive when something changes.

## From your page to Plisto

Only two types are accepted.

### `plisto:pong`

The answer to a ping.

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer, 1 or more | The `seq` of the `plisto:ping` you answer. |

Answer every ping at once, from the listener. A pong with a bad `seq` is dropped.

### `plisto:call`

One API call (see the [API reference](api.md)).

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | integer, 1 or more | Chosen by you, unique among your calls that wait for an answer. The answer carries it back. The SDK counts up from 1. |
| `method` | string | Two to four lowercase dotted parts, at most 64 characters, for example `storage.get`. |
| `args` | string | The arguments as JSON text, not as an object: `JSON.stringify` of an object. At most 262,144 characters. |
| `body` | `ArrayBuffer`, optional | Only on `net.fetch`: the request body, at most 1 MiB, moved with the message in the transfer list. A `body` on another method is refused. |

What comes back for a call that is not valid:

| Fault | Answer |
| --- | --- |
| `id` is not an integer of 1 or more, or the message is not a plain object | None. The message is dropped. |
| `method` is not a string, is over 64 characters or is not shaped like a method name, or `args` is not a string | `plisto:result` with `invalid_args`. |
| `body` on a method other than `net.fetch`, or a `body` that is not an `ArrayBuffer` | `invalid_args`. |
| `args` over 262,144 characters, or a `body` over 1 MiB | `too_large`. |
| The `id` is already waiting for an answer | `invalid_args`. |
| The page already has 32 calls waiting | `busy`. |

## From Plisto to your page

### `plisto:ping`

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer | Echo it in `plisto:pong`. |

Plisto sends one every second. About 5 seconds without a pong shows the not-responding card, and about 15
seconds stops the page.

### `plisto:init`

Sent once, when Plisto has read the plugin's info and method list. Your `ready` is this message.

| Field | Type | Meaning |
| --- | --- | --- |
| `info` | object | The `app.info` result: `api_version`, `plisto_version`, `plugin_id`, `plugin_version`, `locale`, `theme`, `app_mode`, `tier`, `granted`. See the [API reference](api.md#appinfo). |
| `methods` | string[] | Every method this Plisto answers. This is what `plisto.has` reads. |
| `page_open` | boolean | Whether the plugin's page is on screen now. |
| `route` | string or `null` | The page's route now. |

The SDK then sets `data-theme` on `<html>` from `info.theme` and `lang` from `info.locale`.

### `plisto:result`

The answer to one `plisto:call`. Exactly one of the two forms.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | integer | The `id` of your call. |
| `ok` | boolean | `true` or `false`. |
| `result` | any JSON | With `ok: true`. `null` when the method returns nothing. |
| `error` | object | With `ok: false`: `{ code, message, retry_after_ms?, reason? }`. `code` is one of the twelve [error codes](api.md#error-codes). |

A result for an `id` you no longer wait for (your own timeout passed) is to be dropped.

### `plisto:visibility`

| Field | Type | Meaning |
| --- | --- | --- |
| `page_open` | boolean | The plugin's page was shown or hidden. Sent after init, on a change only. |

### `plisto:theme`

| Field | Type | Meaning |
| --- | --- | --- |
| `theme` | `"light"` or `"dark"` | The app theme changed. Update `data-theme` on `<html>` yourself. |

### `plisto:sidebar`

A click on a toggle or action item of the plugin's sidebar section.

| Field | Type | Meaning |
| --- | --- | --- |
| `item_id` | string | The id of the item in the manifest. |
| `value` | boolean or `null` | The position the user asked for on a toggle, `null` on an action. |
| `gesture` | string | A single-use token for `ui.confirm` and `ui.open_page`. See [UI surfaces](ui-surfaces.md#the-prompt-gate-and-gestures). |

### `plisto:route`

| Field | Type | Meaning |
| --- | --- | --- |
| `route` | string or `null` | The page's route changed. Sent only while the page is open. |

### `plisto:event`

An app event of a topic the page subscribed to with `events.subscribe`.

| Field | Type | Meaning |
| --- | --- | --- |
| `topic` | string | One of the topics of the [events guide](events.md). |
| `data` | any JSON | The topic's payload. |

The topic `stream` never arrives here.

### `plisto:plugin-event`

A page event sent by the plugin's native program with `page_event`, and the events of a playback stream the
plugin owns.

| Field | Type | Meaning |
| --- | --- | --- |
| `topic` | string | The program's topic (1 to 64 characters of `a-z`, `0-9`, `_`, `.` and `-`), or `stream` for the events of the plugin's own [stream](stream.md#events). |
| `data` | any JSON | The payload. |

### `plisto:stream`

One piece of a streamed network response, from `net.fetch` with `stream: true`. The `stream` id is the one in
the result of that call. Acknowledge what you read with `net.stream.ack` and cancel with `net.stream.cancel`
(the [network guide](network.md#buffered-and-streamed) has the rules).

| Field | Type | Meaning |
| --- | --- | --- |
| `stream` | string | The stream's id. |
| `kind` | `"chunk"`, `"end"` or `"error"` | What this message is. |
| `seq` | integer | With `chunk`: counts from 1. A missing number means the stream failed. |
| `data` | `ArrayBuffer` | With `chunk`: the bytes. |
| `code`, `reason` | string, string or `null` | With `error`: an error code and its reason. |

Messages may arrive before your code has the stream's id from the call result. Keep them for a short time and
hand them over when it arrives, as the SDK does.

### `plisto:socket`

An event of a WebSocket opened with `net.socket.open`. The `socket` id is the one in that result.

| Field | Type | Meaning |
| --- | --- | --- |
| `socket` | string | The socket's id. |
| `kind` | `"text"`, `"binary"` or `"close"` | What this message is. |
| `data` | string, or `ArrayBuffer` | With `text` and `binary`. |
| `code`, `reason`, `clean` | number, string, boolean | With `close`: the close code, its reason and whether the close was clean. |

## A page without the SDK

This is the least a page needs. It answers the heartbeat, learns that it is initialised and makes one call.

```js
(function () {
  "use strict";
  var next = 1;
  var waiting = {};

  function send(message) {
    message.plisto = 1;
    window.parent.postMessage(message, "*");
  }

  window.addEventListener("message", function (event) {
    var m = event.data;
    if (event.source !== window.parent || !m || m.plisto !== 1) return;
    if (m.type === "plisto:ping") {
      send({ type: "plisto:pong", seq: m.seq });
    } else if (m.type === "plisto:init") {
      call("storage.get", { key: "count" }).then(function (r) { console.log(r.found, m.info.locale); });
    } else if (m.type === "plisto:result" && waiting[m.id]) {
      var w = waiting[m.id];
      delete waiting[m.id];
      if (m.ok) w.resolve(m.result); else w.reject(m.error);
    }
  });

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = next++;
      waiting[id] = { resolve: resolve, reject: reject };
      send({ type: "plisto:call", id: id, method: method, args: JSON.stringify(args || {}) });
    });
  }
})();
```

The page still follows the rules of the [page frame](ui-surfaces.md#what-the-page-frame-allows), and needs a
timeout around each call (the SDK uses 10 seconds), since Plisto answers some faults with silence.
