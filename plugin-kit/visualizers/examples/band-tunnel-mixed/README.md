# Band tunnel with a control page

The `band-tunnel` visualizer plus a small control page: a mixed plugin. Copy the folder to start one.

**Listing.** The manifest has an `entry` page, so Plisto lists the plugin in Settings, Plugins, and its
visualizer still appears in the Visualizers catalog. `npm run kit:check` prints the field that decides this.

**The channel.** The page and the tunnel talk through the [page channel](../../docs/channel.md).

- Page to tunnel: `{ type: "accent", value: "default" | "warm" | "cool" }` on a click,
  and `{ type: "pulse" }`, a short speed surge that never changes brightness.
- Tunnel to page: `{ type: "hello" }` when it starts listening, and `{ type: "energy", value, accent }`, at
  most four a second and only when the level moved. The page answers hello with its accent and resends it
  if a report shows another, so the two never stay apart. A pulse is ignored while the track is paused.
- Rings never pass a pixel more than 3 times a second, pulse included (`MAX_RING_RATE`).

The page keeps its accent in memory only, so a reloaded page starts at default. The tunnel only hears the
page while the page is running.

The page checks `plisto.has("channel.send")` and says so when it is missing. The tunnel reads
`plistoVis.channel` in a frame and works unchanged when it is absent, as in a still or a thumbnail. Nothing
reaches the page while the tunnel is not on the stage, so the page shows a quiet note after two seconds.

`plisto-sdk.js` is a copy of `plugin-kit/sdk/plisto-sdk.js`.
