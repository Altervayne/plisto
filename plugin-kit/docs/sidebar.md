# The sidebar

This page covers how a plugin appears in Plisto's sidebar: the declaration in `plugin.json`, the five
item types, and how a running plugin updates its items live. For chips, toasts and prompts see
[UI surfaces](ui-surfaces.md); for the method's argument table see the [API reference](api.md).

## You own the layout, the user does not

The plugin author decides how the plugin appears in the sidebar. The manifest sets it:

- Whether the plugin is one **compact row** or a **section**.
- Which items it has and in what order.

The user cannot rearrange it, reorder its items or switch a section to a row. The user's only control is
to fold a section closed or open with the arrow on its heading, and Plisto remembers that per plugin.
Plisto also decides which plugins appear at all: a plugin shows only when it is enabled, healthy and
visible in the current app mode (see `modes` in the [manifest reference](manifest.md)). A live update
never adds or removes a section or a row.

Plisto draws every item from fixed components. A plugin supplies labels, icon names and state, never
markup. A section's heading is drawn by Plisto too: the plugin's icon, its manifest name, a tag and the
fold arrow. A plugin cannot set heading text.

Sections come first in the plugins zone of the sidebar, then the compact rows share one group. Both lists
follow install order.

## The declaration

The `sidebar` block in `plugin.json` needs the `ui.sidebar` capability.

```json
"capabilities": ["storage", "background", "ui.sidebar"],
"sidebar": {
  "layout": "section",
  "items": [
    { "id": "home", "type": "nav", "label": "Home", "icon": "house" },
    { "id": "settings", "type": "nav", "label": "Settings", "icon": "cog", "route": "settings" },
    { "id": "state", "type": "status", "label": "Status" },
    { "id": "work", "type": "progress", "label": "Work" },
    { "id": "auto", "type": "toggle", "label": "Automatic" },
    { "id": "ping", "type": "action", "label": "Ping" }
  ]
}
```

| Field | Rule |
| --- | --- |
| `layout` | `"compact"` (the default) or `"section"`. A block with fewer than 2 items is always compact. |
| `items` | 1 to 6 items. |
| `id` | 1 to 32 characters of `a-z`, `0-9` and `-`. Unique in the plugin. |
| `type` | `nav`, `status`, `progress`, `toggle` or `action`. |
| `label` | Required. 1 to 24 characters, plain text. |
| `route` | `nav` only. 1 to 64 visible ASCII characters. |
| `icon` | `nav` only. One of the icon names below. |

A `route` or `icon` on any other type is refused. A UI plugin with any item that is not `nav` also needs
the `background` capability, because live items need a running page.

Without a `sidebar` block the plugin is one compact row with its name and icon, which opens its page.

### Compact row and section

- **Compact row.** One row in the shared plugins group. The row opens your page. It carries your chips
  (see [UI surfaces](ui-surfaces.md)). Whatever items you declare, a compact plugin is one row.
- **Section.** Your own block with a heading and your items under it. Use it when your plugin has several
  pages or live items. Chips go on nav items instead of the heading.

### Icon names

A nav item's `icon` must be one of: `activity`, `album`, `archive`, `audio-lines`, `audio-waveform`,
`bell`, `bookmark`, `chart-bar`, `circle-help`, `clock`, `cloud`, `cog`, `compass`, `database`, `disc-3`,
`download`, `drum`, `file-text`, `folder`, `gauge`, `globe`, `guitar`, `headphones`, `heart`, `house`,
`info`, `layout-grid`, `library`, `list-music`, `mic`, `music`, `music-2`, `puzzle`, `radio`,
`sliders-horizontal`, `sparkles`, `star`, `tag`, `timer`, `wand-sparkles`, `zap`. Any other name makes the
manifest invalid. A nav item with no icon shows a plain dot.

## Item types

| Type | What the user sees | What it does |
| --- | --- | --- |
| `nav` | A link with an optional icon. | Opens your page at the item's `route`, or at the start when it has none. |
| `status` | One line of text. | Shows what you send with `ui.sidebar.update`. |
| `progress` | A bar, with optional text. | Shows a value from 0 to 1, or a slow sweep when the value is `null`. |
| `toggle` | A switch. | Sends you a `sidebar` event when the user clicks it. |
| `action` | A button. | Sends you a `sidebar` event when the user presses it. |

Nav items are drawn from the manifest alone and work even when your page is not running. Every other type
is live: it needs your page running, which is why they require `background`.

Until you send a state, Plisto draws the declared form: a status, progress or toggle with no state reads
as unavailable. An action is pressable once your page is running.

Nav items also appear in the finder (Ctrl+K) as "Plugin name: Label", so the user can jump to them by
typing. Declare at least one nav item in a section so users can open your page.

## Updating items live

```js
plisto.ui.sidebar.update(itemId, state);
```

Needs `ui.sidebar`. The state must fit the item's type, and every update replaces the whole state: a field
you leave out takes its default.

| Type | State fields (defaults) |
| --- | --- |
| `nav` | `label?` string or `null` (the declared label), `chip?` a chip or `null` (none), `visible?` (true) |
| `status` | `text` required, 1 to 40 characters. `tone?` (`"neutral"`, `"accent"` or `"warn"`; default neutral), `visible?` |
| `progress` | `value` required: a number from 0 to 1, or `null` for a sweep. `text?` string or `null`, up to 40 characters. `visible?` |
| `toggle` | `on` required, boolean. `enabled?` (true), `visible?` |
| `action` | `label?` string or `null` (the declared label), up to 24 characters. `enabled?` (true), `visible?` |

A chip here has the same shape as in `ui.chips`: `{ text }` or `{ count }`, and an optional `tone`.

```js
plisto.ui.sidebar.update("state", { text: "Syncing 3 of 12", tone: "accent" });
plisto.ui.sidebar.update("work", { value: 0.25, text: "25%" });
plisto.ui.sidebar.update("auto", { on: true });
plisto.ui.sidebar.update("home", { chip: { count: 3 } });
```

Rules:

- An id the manifest does not declare is `not_found`. A state of the wrong shape is `invalid_args`.
- `visible: false` hides one item inside your section.
- You may send up to 10 updates per second (20 at once). Plisto draws at most one change per item every
  half second, and the last value wins, so updating faster gains nothing. Nothing flashes, and the
  progress sweep stops under the system's reduced-motion setting.
- Changes of appearance are slower: showing or hiding an item, a status tone, a toggle's on/off or
  enabled state, a chip's tone or how many chips there are, and a progress bar switching between
  sweeping and a value. Plisto draws one of these at most every 2 seconds per item (per plugin for
  chips); a sooner one waits and the last value wins. Text, labels and progress values keep the
  half-second pace. Plisto never lets a row blink, so do not signal with alternating state.
- State is kept in memory only. It is cleared when the plugin is disabled, updated or crashes, so send it
  again when your page starts. State sent while your page is closed is kept, for a background plugin.

## Receiving clicks

When the user clicks a toggle or presses an action, your page gets a `sidebar` event:

```js
plisto.on("sidebar", ({ item_id, value, gesture }) => {
  if (item_id === "auto") {
    // value is the position the user asked for: true or false.
    plisto.ui.sidebar.update("auto", { on: value });
  }
});
```

- `value` is the position the user asked for (`true` or `false`) on a toggle, and `null` on an action.
- `gesture` is a single-use token you may pass to `ui.confirm` or `ui.open_page` (see
  [UI surfaces](ui-surfaces.md)).
- A toggle does not move when clicked. It dims until you send its next state, or for 3 seconds. Plisto
  never shows a position you did not set. Confirm the click by calling `update` with the new `on`, or
  refuse it by sending the old one.
- While your page is not responding, toggles and actions are disabled.
- Clicks are limited to a burst of 5, then 5 per second.
- A click is dropped if your page is not running. It is never replayed later, so a click never acts on a
  decision that has gone stale.

## A complete example

[`examples/hello-background`](../examples/hello-background/) declares one item of each type and drives
them from a one-second timer. Read its `plugin.json` and `hello.js` together.
