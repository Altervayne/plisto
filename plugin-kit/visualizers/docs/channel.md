# The page channel

A plugin that has a page or a background frame, next to its visualizers, can pass messages between the two
while the visualizer runs. The page can tune the visualizer live; the visualizer can report back to the page.
A plugin with visualizers only has no page, so it has no channel.

Plisto relays every message and nothing else. A message never leaves the plugin: it goes only between frames
of the same plugin.

## From the visualizer

`plistoVis.channel` exists only when the plugin has a page or a background frame. Read it in `setup` or in
`frame`, not when the script loads: the host tells the frame at init.

```js
let gain = 1;
let off = null;
plistoVis.raw({
  setup() {
    off = plistoVis.channel?.onMessage((data) => {
      if (data.type === "gain") gain = data.value;
    });
    plistoVis.channel?.send({ type: "ready" });
  },
  frame(f) { /* draw with gain */ },
  dispose() {
    off?.();
  },
});
```

- `channel.send(data)` sends to the page and to the background frame, whichever exist. It returns nothing.
- `channel.onMessage(fn)` calls `fn(data)` for each message from the page. It returns an unsubscribe function.

## From the page or the background frame

```js
const off = plisto.visualizers.onMessage((data, from) => {
  if (data.type === "ready") plisto.visualizers.send({ type: "gain", value: 0.8 }, from.kind);
});
plisto.visualizers.send({ type: "gain", value: 1 });
```

- `plisto.visualizers.send(data, kindId?)` sends to every live visualizer frame of this plugin, or only to the
  frames of the kind `kindId`.
- `plisto.visualizers.onMessage((data, from) => ...)` receives what a visualizer sent. `from` is
  `{ kind: kindId }`, the kind that sent it. It returns an unsubscribe function.
- Both a page and a background frame, when the plugin has both, receive every message from a visualizer.

## Limits

- A message is JSON and at most 16384 bytes of it (UTF-8). `send` throws a `RangeError` over that and a
  `TypeError` for data that cannot be serialized: a cycle, a function, `undefined`, a `BigInt`.
- Each sending frame may send at most 20 messages in any one second, counted over a sliding window.

## Which frames take part

Only a visualizer frame that is shown takes part: the Player's or the ambient background's current kind,
drawn on screen. A frame kept hidden for a quick return, and one still compiling while the stage shows the
previous kind, neither receive nor send. The still behind a catalog tile and a preview thumbnail never take
part and never have `plistoVis.channel`.

A kind shown on both surfaces at once has two frames. The page hears each frame's messages, so it gets one
per frame, and a message from the page reaches both. The page can tell them apart only by what they send.

Find out whether the running Plisto has the channel with `plisto.has("channel.send")`.

## What is dropped

A message is dropped, and the sender is not told: the call still succeeds. It is dropped when:

- it is over the rate or the size (Plisto checks the size again, whatever the sender did);
- nobody is on the other side: no shown visualizer frame, or no page and no background frame;
- the sender is not a page or background frame, or a shown visualizer frame, of this plugin.

Nothing is held for a frame that appears later. A page that must know the visualizer is there waits for its
message, as in the example above.

In developer mode, each kind of drop writes one line to the plugin's log, at most once a second.

## Trying it

The [harness](harness.md) has a Channel box that plays the page: type JSON, send it to the frame, and read
what the frame sends back. The mock host (`plugin-kit/sdk/mock-host.html`) does the same for a page: it
lists what the page sends and sends the page a message as a visualizer.
