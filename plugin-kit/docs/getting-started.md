# Getting started

This page builds a small plugin from an empty folder: a counter that survives restarts. It ends with the
plugin installed and visible in the sidebar. The finished idea is the same as
[`examples/hello-ui`](../examples/hello-ui/), which you can open beside this page.

You need a text editor and Plisto 2.7 or newer (or a pre-release build, see step 2). No build tools are required.

## 1. Make the folder

```
my-plugin/
  plugin.json
  index.html
  app.js
  plisto-sdk.js
```

A plugin is self-contained: everything it needs sits in its own folder, including its own copy of the
SDK. Copy `sdk/plisto-sdk.js` from this kit into `my-plugin/`.

## 2. Write the manifest

`plugin.json` tells Plisto what the plugin is and what it needs.

```json
{
  "manifest_version": 1,
  "id": "com.example.counter",
  "name": "Counter",
  "version": "1.0.0",
  "tier": "ui",
  "entry": "index.html",
  "capabilities": ["storage"],
  "min_plisto": "2.7.0",
  "author": "Your Name"
}
```

- `id` is your plugin's permanent name: reverse-DNS style, lowercase, for example `com.example.counter`.
  Pick it once. Changing it later makes a different plugin.
- `capabilities` lists what the plugin may do. `storage` lets it save data. The user sees this list
  before the plugin is turned on.
- `entry` is the page Plisto opens.
- `min_plisto` is the oldest Plisto version the plugin works with. Use `"2.7.0"` for a release. While
  you develop against a pre-release build that still reports 2.6.x, use `"2.6.0"`, because Plisto refuses
  to turn on a plugin that needs a newer version than the build. See the
  [manifest reference](manifest.md#version-and-min_plisto).

Every field, limit and rule is in the [manifest reference](manifest.md).

## 3. Write the page

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Counter</title>
    <link rel="stylesheet" href="/_plisto/tokens.css" />
    <link rel="stylesheet" href="/_plisto/plugin-base.css" />
    <script src="plisto-sdk.js"></script>
    <script src="app.js" defer></script>
  </head>
  <body>
    <h1>Counter</h1>
    <p id="count">...</p>
    <button type="button" id="add">Add one</button>
  </body>
</html>
```

The rules that matter here:

- Load scripts as classic scripts with `src`. A script with `type="module"` does not load, and an inline
  `<script>` block never runs. All code goes in `.js` files in your folder.
- Load `plisto-sdk.js` first, in `<head>`. It starts answering Plisto at once. Load your own script with
  `defer` so it runs after the page is parsed.
- No external addresses: no CDN, no remote fonts, no analytics. Put what you need in the folder.
- Use hash routing (`#/page`) if you need routes. Anything that loads a new document, a reload included,
  counts as the page crashing.

### Styling with Plisto's tokens

The two `<link>` lines load files that Plisto serves itself:

- `/_plisto/tokens.css` defines Plisto's colors, radii and fonts as CSS variables: `--bg`, `--surface`,
  `--surface-2`, `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--warn`, `--danger`, `--good`, `--hairline`,
  `--r-sm`, `--r-md`, `--r-lg`, `--font-ui`, `--font-mono` and others.
- `/_plisto/plugin-base.css` gives a transparent page background, the UI font and ink color, some body
  padding and a focus ring.

Light and dark follow the `data-theme` attribute on `<html>`, which the SDK sets when the page starts and
whenever the theme changes. Use the variables and your page follows the theme with no code.

```css
.card { background: var(--surface); border-radius: var(--r-md); padding: 16px; }
```

The tokens track Plisto's own look and are not versioned. A name can change, so keep to the common ones
above. Never set `color-scheme` in your CSS: a value that differs from Plisto's paints an opaque box
behind the page.

Put your own styles in a `.css` file next to the page and link it after the two Plisto sheets.

## 4. Write the script

`app.js`:

```js
(function () {
  "use strict";

  var countEl = document.getElementById("count");
  var count = 0;

  function show() {
    countEl.textContent = String(count);
  }

  plisto.ready.then(function (info) {
    // Plisto has initialised the page. info holds the app language, theme and so on.
    return plisto.storage.get("count", 0).then(function (saved) {
      count = saved;
      show();
    });
  });

  document.getElementById("add").addEventListener("click", function () {
    count += 1;
    show();
    plisto.storage.set("count", count).catch(function (e) {
      plisto.log.warn("save failed: " + e.code);
    });
  });
})();
```

What this uses:

- `plisto.ready` is a promise that resolves with the app info once Plisto has initialised the page.
- `plisto.storage.get(key, fallback)` returns the saved value, or the fallback when the key does not exist.
- `plisto.storage.set(key, value)` saves any JSON value.
- `plisto.log.warn(text)` writes a line to your plugin's log file.

Every call returns a promise and can reject with a `PlistoError` that has a `code`. The full list is in
the [API reference](api.md).

## 5. Install it

1. In Plisto, open Settings > Plugins.
2. Choose Install from folder and pick `my-plugin`.
3. Read the review sheet. It lists what the plugin asks for. Press Install.
4. The plugin lands in the list turned off. Turn its switch on.

If Plisto refuses the folder, it says why. Common causes: `plugin.json` has a typo or a missing field, a
file named in the manifest is missing, or an `id` that breaks the rules. See the
[manifest reference](manifest.md).

## 6. See it in the sidebar

With the plugin on, it has a row in the sidebar under its own name, in the plugins zone. Click it and
your page opens. Click Add one a few times, quit Plisto, start it and open the plugin again: the count
is still there, because it was saved with `storage.set`.

A plugin with no `sidebar` block gets one row like this. To give it a section with several links, or
live items such as a progress bar, see the [sidebar guide](sidebar.md).

## 7. Change it and try again

Edit your files, raise `version` in `plugin.json` (for example to `1.0.1`), then install the folder again
in Settings > Plugins. Plisto sees the same `id` and offers an update that replaces the old version and
keeps your saved data. The [install and test guide](install-and-test.md) has the details and a debugging
checklist.

## Develop in a browser with the mock host

You can run the page in an ordinary browser before you install anything. `sdk/mock-host.html` frames your
page in a sandboxed frame with the same `sandbox` attribute Plisto uses, does the same handshake and heartbeat,
and answers the SDK's calls with canned data: a small fixed library of tracks, albums and playlists, storage
kept in memory, and a fake transport you can click. Toasts and prompts appear in a strip above the page, the
sidebar items your manifest declares are listed beside it, and a Calls panel lists every call and reply,
newest first.

Serve the kit over http from the kit's folder (node only, nothing to install). Give it your plugin folder
to frame your own page:

```
node sdk/mock-serve.mjs 8765 path/to/my-plugin
```

Then open `http://127.0.0.1:8765/sdk/mock-host.html?page=/plugin/index.html`. Without the folder argument the
kit is served alone, and `page` can name a kit example, such as `?page=../examples/hello-ui/index.html`. The
mock reads `plugin.json` from the page's folder (or the one above it) and answers the capability checks
from its `capabilities`, with the same `denied` error Plisto gives. If it cannot read the manifest it says so
and allows every capability. The server also serves Plisto's `/_plisto/tokens.css` and
`/_plisto/plugin-base.css` from the app's `src/styles` when the kit sits in the Plisto repository; elsewhere
those two links return 404 and the page is unstyled.

Know what it is not:

- It is a mock. The data is canned, there is no content security policy and no real sandbox check, and it
  applies no rate budgets and only part of Plisto's argument checks. A page that works here is not proven.
  The real check is installing the plugin in Plisto.
- A method it does not answer fails with an error that says so and appears in the Calls panel. Today that
  is every `net.*` method. `plisto.has` is false for them. A native plugin's program does not run.
- Cover images are small SVGs, where Plisto sends JPEGs.
- It needs http. Opened from `file://`, browsers block the manifest read and may block the frame's own
  files, so use the server above.

## Where to go from here

- Packing a UI plugin to share: [install and test](install-and-test.md#pack-a-ui-plugin).
- Toasts, prompts and chips: [UI surfaces](ui-surfaces.md).
- Running in the background: [lifecycle](lifecycle.md).
- Talking to a web service: [network](network.md).
- A program that runs beside Plisto, or reading the audio: [native plugins](native.md).
- Every method with its limits: [API reference](api.md).
- A larger working example: [`examples/hello-background`](../examples/hello-background/).
