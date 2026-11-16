# Network

A plugin page cannot open connections itself: its security policy blocks every request. With the `network`
capability, Plisto makes the requests for the page. The page asks through `plisto.net`, Plisto checks the
request, sends it, and hands back the answer. This page covers what a plugin must declare, every method with
its limits and errors, buffered and streamed responses, Server-Sent Events, sockets and images.

The network methods are part of the plugin system from its first release, Plisto 2.7, and `plisto.net` is in
SDK 1.3.0 and later. As with any method, `plisto.has("net.fetch")` tells you whether this Plisto has them;
see [Feature detection](api.md#feature-detection). A few parts are not reachable from Plisto's interface yet:
see [Not available yet](#not-available-yet) at the end of this page.

## What needs consent

Every method on this page needs the `network` capability, and the manifest must list the sites the plugin
talks to in a `network` array of origins. Plisto grants all of the plugin's capabilities or none, and the user
sees the origin list on the review sheet before the plugin runs.

```json
{
  "capabilities": ["network"],
  "network": ["https://api.example.com", "https://cdn.example.com:8443"]
}
```

What the user reads on the sheet, in short: the plugin can exchange data with the listed sites, Plisto makes
the connections and refuses every other address, and the sites see the user's internet address, as when the
user visits them. When the plugin also holds `library.read` or `playback.read`, the sheet adds that the
plugin can send what it reads there, such as the library or what is playing, to those sites. Ask only for the
origins you use, and say on your `homepage` what your plugin sends and why.

### Origins

- `https://host`, with an optional port. `:443` is the same as no port. At most 8 origins of at most 128
  characters, no duplicates.
- The host is lowercase letters, digits and hyphens in at least two labels. No IP address, no wildcard, no
  userinfo, no path. A name with non-ASCII letters is written in its `xn--` form.
- An origin matches a request whose scheme (`https`, or `wss` for a socket), host and port are the same.
  `https://example.com` does not match `https://www.example.com`, another port, or `https://example.com.`
  with a trailing dot. List each origin you use.
- The list must be present when `network` is declared, and absent otherwise.
- A request outside the list is refused with `denied` and reason `origin_not_listed`.

### Developer loopback origins

To talk to a server on your own computer while you build, list `http://127.0.0.1:<port>` or
`http://localhost:<port>`. The port is required. Nothing else over `http` is accepted: not `[::1]`, not
`0.0.0.0`, not `https://localhost`. A socket to the same address uses `ws://`.

These origins work only while developer mode is on in Plisto's settings, for every plugin that lists one.
With developer mode off, a request to one is refused `denied` with reason `dev_only`. Both names connect to
`127.0.0.1` only. The user sees such an origin marked as this computer, and the developer mode switch says
that plugins listing an address on this computer can connect to it while it is on. Remove them before you
publish.

## What Plisto does for you, and what it refuses

- Every name is resolved by Plisto and the connection goes only to public internet addresses. A name that
  resolves to a private, loopback, link-local or other non-public address is refused (`denied`, reason
  `blocked_address`), and so is a name with even one such address among its answers. IP addresses cannot be
  listed or requested.
- HTTP/1.1 only, and no compression: Plisto sends `accept-encoding: identity`. Bodies are exactly the bytes on
  the wire.
- TLS uses the system certificate store. A bad certificate fails with `network` and reason `tls`. There is no
  way to override it.
- Plisto sets `host`, `content-length` and `accept-encoding`. It sets `user-agent` to
  `Plisto/<version> (<plugin id>/<plugin version>)` unless you set one. It sends no `origin`, `referer` or
  `cookie` of its own.
- There is no CORS. The page's own origin is opaque, so no check applies and no `Origin` header is sent;
  a server that insists on one needs you to set it in `headers`.
- There is no cookie jar. A `Set-Cookie` header comes back in `setCookies` and is never stored or sent again.
  To keep a session, store the cookie value or token with `plisto.storage` and send it in `cookie` or
  `authorization` yourself. Nothing is shared between plugins.
- A system proxy is not used. Plisto connects directly because a proxy would hide the real target from the
  address check. When Windows has a proxy configured, Plisto shows the user a warning on the review sheet and
  in the plugin's panel, and a request that fails to connect (`dns`, `connect`, `tls` or `closed`) is reported
  as `network` with reason `proxy`. See the error table below.
- Plisto blocks WebRTC from plugin pages. `RTCPeerConnection` still exists, but it cannot reach a STUN or TURN
  server or a peer, with or without the `network` capability. Use the `plisto.net` methods on this page for
  network access.

## `plisto.net.fetch(url, init?)`

Resolves a `PlistoResponse` for any HTTP status, including 404 and 500: those are results, not errors. It
rejects with a `PlistoError` when the request could not be made or finished.

```js
const res = await plisto.net.fetch("https://api.example.com/items?q=blue");
if (res.ok) {
  const items = await res.json();
}
```

`init` fields, all optional:

| Field | Meaning |
| --- | --- |
| `method` | `GET` (default), `HEAD`, `POST`, `PUT`, `PATCH` or `DELETE`. The SDK upper-cases it. |
| `headers` | An object, a `Headers` or a list of pairs. See the header rules below. |
| `body` | A string, `ArrayBuffer`, typed array or `URLSearchParams`, at most 1 MiB. Not with `GET` or `HEAD`. |
| `json` | A value sent as JSON. Not together with `body`. |
| `redirect` | `"follow"` (default), `"manual"` returns a 3xx as is, `"error"` fails on a 3xx. |
| `timeoutMs` | 1000 to 120000, default 30000. Buffered: the whole call. Streamed: until the headers arrive. |
| `signal` | An `AbortSignal`. Aborting rejects the call with `aborted`. |
| `stream` | `true` for a streamed response. See below. |
| `idleMs` | Streamed only: 5000 to 600000, default 60000. |

The SDK sets `content-type` when you did not: `application/json` for `json`, `text/plain;charset=UTF-8` for a
string, `application/x-www-form-urlencoded;charset=UTF-8` for `URLSearchParams`. A binary body gets none. The
body bytes are copied and moved to Plisto, so your own buffer stays usable.

```js
await plisto.net.fetch("https://api.example.com/items", {
  method: "POST",
  json: { name: "Blue" },
  headers: { authorization: "Bearer " + token },
});
```

### Headers

- At most 32 headers, 16 KiB in all. A name is an HTTP token of at most 64 bytes, compared without regard to
  case. A value is visible ASCII or tab, at most 4096 bytes.
- Refused with `invalid_args` and reason `forbidden_header`: `accept-encoding`, `connection`, `content-length`,
  `expect`, `host`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, any name starting `proxy-`
  and any starting `sec-websocket-`.
- Everything else is allowed, including `authorization`, `cookie`, `user-agent`, `origin`, `referer`,
  `content-type` and `last-event-id`.

### The response

| Member | Meaning |
| --- | --- |
| `status`, `ok` | The HTTP status; `ok` is true for 200 to 299. |
| `url`, `redirected` | The final URL after redirects, and whether there were any. |
| `headers` | A `Headers`. Names are lowercase; `set-cookie` is not in it. Non-ASCII values read as Latin-1. |
| `setCookies` | The `Set-Cookie` values, as a list of strings. |
| `body` | A `ReadableStream` of `Uint8Array`. |
| `bodyUsed` | True once a reader below ran or the stream was locked. |
| `arrayBuffer()`, `bytes()`, `text()`, `json()`, `blob()` | Read the whole body. Each works once; a second read rejects with `TypeError`. |

A buffered body is empty for `HEAD`, `204` and `304`.

### Redirects

With `"follow"`, Plisto follows at most 5 hops and checks each `Location` against your origin list before any
connection. A hop that leaves the list, or goes from `https` to `http` (even to a developer origin), is refused
`denied` with reason `redirect_not_listed`, and nothing is sent to it. More than 5 hops, or any redirect with
`"error"`, is `network` with reason `redirect`.

As in browsers, 301 and 302 turn `POST` into `GET` without a body, 303 turns every method except `HEAD` into
`GET` without a body, and 307 and 308 keep the method and body. A hop to another origin drops `authorization`
and `cookie`. The same rules apply to streamed requests.

### Abort keys

A raw `net.fetch` or `net.abort` call names a request by an abort key of 1 to 64 visible ASCII characters.
Keys that start with `plisto:` are reserved for Plisto's own work, such as a playing stream's connection, and
are refused with `invalid_args`.

## Buffered and streamed

**Buffered** (the default) waits for the whole body, at most 8 MiB, and resolves one `ArrayBuffer`. A larger
body is `too_large` with reason `response_body`; Plisto checks `content-length` first, then counts. The request
holds one of the plugin's in-flight call slots until it ends.

**Streamed** (`stream: true`) resolves as soon as the response headers arrive and delivers the body as it
comes. There is no total size limit and no total duration limit: a live stream runs until the server, your
page or the user ends it. Use it for large downloads, live feeds and Server-Sent Events.

```js
const res = await plisto.net.fetch("https://api.example.com/log", { stream: true });
const lines = res.body.pipeThrough(new TextDecoderStream());
for await (const text of lines) {
  show(text);
}
```

The body is the web's own `ReadableStream`, so `pipeThrough`, `TextDecoderStream` and `for await` work as they
do for the browser's own `fetch`. A response without a body (`204`, `304`) gives an empty, closed stream.

Backpressure keeps memory flat. Plisto sends at most 1 MiB beyond what your page has read; the SDK tells
Plisto how much was read (once 256 KiB are read, or 250 ms after any read). Plisto buffers up to 4 MiB more
and then stops reading the connection, so the server is slowed down by TCP. Nothing is dropped. A page that
reads slowly therefore slows the transfer, and a live server that drops slow listeners ends the stream with
`network` and reason `closed`. If your page reads nothing for 60 seconds while data waits, Plisto ends the
stream with `network` and reason `stalled`. A hidden window slows reads but does not stop them.

`idleMs` ends a stream that receives no bytes for that long (`timeout`, reason `idle`). Choose it longer than
the server's keep-alive interval.

Ending a stream:

- `res.body.cancel()` (or leaving a `for await` early) tells Plisto to drop the connection.
- Aborting the `signal` given to the request ends the stream as well. The body then errors with `aborted`.
- A stream you stop reading but do not cancel keeps its slot. Cancel it.
- The body errors with a `PlistoError` when the stream fails. Chunks arrive in order; if one is missing the
  stream fails with `network` and reason `protocol`.

`arrayBuffer()`, `text()` and the other readers read to the end, so on a live stream they never finish. Read
`body` instead.

### Reading a stream in your own code

The SDK's stream reading is made of small pure functions that you can read in `sdk/plisto-sdk.js`:
`createStreamBody` turns host chunks into the `ReadableStream` and decides when to acknowledge, and
`readAll` reads a stream to one `Uint8Array`. The kit's tests in `tests/net-sdk.mjs` run them without a
network, with `node --test tests/net-sdk.mjs`. They are reachable as `plisto.net.internals` for that purpose
and are not part of the API.

## Server-Sent Events

`plisto.net.eventSource(url, options?)` reads a Server-Sent Events feed on a streamed request and parses it to
the HTML standard: `data`, `event`, `id` and `retry` fields, comments, any line ending, a leading byte order
mark. It looks like the browser's `EventSource`.

```js
const source = plisto.net.eventSource("https://api.example.com/events", {
  headers: { authorization: "Bearer " + token },
});
source.onmessage = (e) => show(JSON.parse(e.data));
source.addEventListener("price", (e) => update(e.data));
source.onerror = (e) => {
  if (e.error && e.error.code === "denied") askUserToCheckSettings();
};
// later
source.close();
```

- `options`: `headers`, `lastEventId`, `timeoutMs`, `idleMs`.
- Members: `url`, `readyState` (0 connecting, 1 open, 2 closed), `onopen`, `onmessage`, `onerror`,
  `addEventListener`, `removeEventListener`, `close()`. A message event has `type`, `data` and `lastEventId`.
  An error event has `error`, the `PlistoError` behind it or `null`.
- The reply must have `content-type: text/event-stream` and status 200. Otherwise the source fires `error`
  and closes.
- After the server closes the stream, or a `network`, `timeout`, `busy` or `rate_limited` error, the source
  fires `error`, waits, and connects again with the `last-event-id` header. The wait is the server's `retry`
  value, 3000 ms by default and never under 1000 ms. Each reconnect is a new request under the same limits.
- The source stops for good on `close()`, on a 204, on any other status, on a reply that is not an event
  stream, and on an error retrying cannot fix, such as `denied`.
- A line or an event over 1 MiB fails the source with `too_large` (reason `event`) and ends the stream.
- A server event named `open` or `error` is delivered only to listeners added for that name; `onopen` and
  `onerror` are Plisto's own events. `onmessage` receives events of type `message` only.

The parser itself is `plisto.net.internals.createEventParser(handlers, lastEventId)`. Feed it decoded text with
`push(text)` in any slicing; it calls `onEvent({ type, data, lastEventId })`, `onRetry(ms)` and `onId(id)`.

## Sockets

`plisto.net.socket(url, options?)` opens a WebSocket through Plisto and resolves a `PlistoSocket` after the
handshake. The URL is `wss://` and matches a public origin, or `ws://` and matches a developer origin. There
are no redirects; any answer but 101 is `network` with reason `handshake`.

```js
const socket = await plisto.net.socket("wss://api.example.com/live", { protocols: ["v1"] });
socket.onmessage = (e) => {
  if (typeof e.data === "string") handleText(e.data);
  else handleBinary(e.data); // an ArrayBuffer
};
socket.onclose = (e) => console.log(e.code, e.reason, e.wasClean);
await socket.send(JSON.stringify({ hello: true }));
await socket.close(1000, "done");
```

- `options`: `protocols` (at most 8 tokens of at most 64 bytes), `headers` (the rules above), `timeoutMs`
  (1000 to 30000, default 15000, for the handshake).
- Members: `id`, `protocol` (the subprotocol the server chose, or `null`), `send(data)`, `close(code?, reason?)`,
  `onmessage`, `onclose`. Messages that arrive before you set `onmessage` are held and delivered when you
  set it: the newest 100 messages and 4 MiB are kept, older ones are dropped. The close is always kept and
  reaches `onclose` even when `onmessage` is not set; messages still held at that point are dropped.
- `send` takes a string (text) or an `ArrayBuffer` or typed array (binary), at most 64 KiB. At most 16 sends
  can be queued; more is `busy`. After the close, a send is `not_found`.
- `close` takes a `code` of 1000 or 3000 to 4999 (default 1000) and a `reason` of at most 123 bytes.
- Incoming messages are at most 1 MiB, and at most 100 messages and 4 MiB per second per socket. Beyond that
  Plisto closes the socket with code 1008 and reason `plisto_limit`.
- A frame that goes away (the page closes) closes its sockets with 1001.
- A socket does not keep an in-flight call slot once it is open. A plugin may have 2 sockets open, and Plisto
  8 across all plugins; more is `busy`.

## Images

A direct `<img src="https://...">` is blocked. Fetch the image through Plisto instead:

```js
const url = await plisto.net.imageUrl("https://cdn.example.com/cover.jpg");
img.src = url;
// when the image is no longer shown
plisto.net.revoke(url);
```

`imageUrl` resolves a `blob:` URL, or a `data:` URL when blob URLs are unavailable. A blob URL works only in
your own page. `revoke` frees it and does nothing for a `data:` URL. A reply that is not a 2xx or not an
`image/` type rejects with a plain `Error` that carries `status`. The image counts as a buffered response, so
it is at most 8 MiB.

## Limits

| Limit | Value |
| --- | --- |
| Request body | 1 MiB (`too_large`, reason `request_body`) |
| Buffered response body | 8 MiB (`too_large`, reason `response_body`) |
| Fetches in progress | 4 per plugin, 12 for the whole app (`busy`) |
| Streams open | 2 per plugin, 8 for the whole app (`busy`) |
| Sockets open | 2 per plugin, 8 for the whole app (`busy`) |
| URL | at most 8192 bytes, no userinfo; the fragment is dropped |
| Connect timeout | 10 seconds, fixed |
| Rate, `net.fetch` and `net.socket.open` | burst 30, 10 per second |
| Rate, send, close, abort and stream cancel | burst 40, 20 per second |
| Rate, stream acknowledgements | burst 40, 20 per second |
| All calls together | burst 100, 50 per second, as for every method |

The SDK waits `timeoutMs` plus 5 seconds for a call, so Plisto answers a timeout first. Past a rate limit a
call rejects with `rate_limited` and `retryAfterMs`.

## Errors

Every failure is a `PlistoError`. `code` and `reason` are what to branch on; messages are fixed English text
for you, not for display.

| `code` | `reason` | When, and what to do |
| --- | --- | --- |
| `invalid_args` | none | The arguments break a rule above: a bad URL, method, header or body. Fix the call. |
| `invalid_args` | `forbidden_header` | A header Plisto sets itself. Remove it. |
| `denied` | none | The plugin does not hold `network`. Declare it and ask the user to approve. |
| `denied` | `origin_not_listed` | The URL's origin is not in the manifest list. Add it; the user must approve the update. |
| `denied` | `redirect_not_listed` | A redirect left the list or went from `https` to `http`. List the new origin or use the final URL. |
| `denied` | `blocked_address` | The name resolves to a non-public address. It cannot be reached from a plugin. |
| `denied` | `dev_only` | A developer origin while developer mode is off. Turn it on, or use a public origin. |
| `too_large` | `request_body` or `response_body` | Over 1 MiB sent, or over 8 MiB received. Send less, or use a streamed request. |
| `busy` | none | Too many requests, streams or sockets at once, or a socket's send queue is full. Wait and retry. |
| `rate_limited` | none | A budget is empty. Retry after `retryAfterMs`. |
| `timeout` | none | `timeoutMs` passed. Retry, or raise it. |
| `timeout` | `idle` | A stream received no bytes for `idleMs`. Reconnect, or raise `idleMs`. |
| `aborted` | `abort` | You aborted, or cancelled the stream. Not an error to report. |
| `aborted` | `frame_gone` | The page closed or crashed. Nothing to do. |
| `aborted` | `stopped` | The plugin was disabled, updated or removed. Nothing to do. |
| `network` | `dns` | The name was not found. Check the origin. |
| `network` | `connect` | The connection was refused or unreachable. Retry later. |
| `network` | `tls` | The certificate or handshake failed. The site is misconfigured or the connection is intercepted. |
| `network` | `protocol` | The response was malformed, or a stream chunk was lost. Retry. |
| `network` | `closed` | The connection was reset or the server dropped a slow reader. Retry; read faster. |
| `network` | `redirect` | More than 5 hops, or a redirect with `redirect: "error"`. |
| `network` | `handshake` | The socket upgrade was refused. Check the URL, protocols and headers. |
| `network` | `stalled` | The page acknowledged no stream data for 60 seconds. Keep reading while a stream is open. |
| `network` | `proxy` | Windows has a proxy configured and the connection failed. See below. |
| `not_found` | none | An unknown or foreign socket or stream. It may have already closed. |
| `unknown_method` | none | This Plisto is older than the network methods, or the call came from a native plugin's program, which cannot use `net.*`. |
| `unavailable` | none | The plugin is disabled or updating. |

For `network` with reason `proxy`: Plisto does not send plugin connections through a proxy, and a failed
connection on a computer with one configured is reported this way instead of as `dns`, `connect`, `tls` or
`closed`. Plisto already shows the user a warning about the proxy on the review sheet and the plugin's panel;
your page should tell the user plainly that the connection failed and may be blocked by their proxy, and
offer to retry. Do not retry in a tight loop.

## What Plisto records

Plisto keeps the last 200 requests of each plugin in memory only, so the user can see them in the plugin's
log once a screen for it exists: time, kind, method, origin, status or error, bytes each way and duration. It never records paths, queries,
headers, bodies or cookies.

## Not available yet

One thing described above cannot be used from Plisto's interface yet: no screen shows the request log.
Plisto records it as described above, but the plugin's panel does not display it yet.

The developer mode switch is in Settings > Plugins, under Safe mode. See
[install and test](install-and-test.md#developer-mode).
