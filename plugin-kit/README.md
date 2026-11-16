# Plisto plugin kit

This kit has what you need to build a Plisto plugin: guides, the API reference, the SDK and three working
example plugins. Start here, then follow the links.

## What a Plisto plugin is

A plugin adds a page to Plisto, and can add entries to the sidebar. It is a folder of web files: an HTML
page, scripts, styles and a `plugin.json` that describes it. Plisto runs the page in a sandboxed frame and
the page talks to Plisto through a small API.

There are two tiers of plugin:

- The **UI tier** is a sandboxed web page, as described above. Most plugins are this.
- The **native tier** is a Windows program that Plisto starts as a child process and talks to over its
  standard input and output. It can have a page too. It can read the audio Plisto plays, follow playback
  as events and hold Plisto's own output silent, which a page cannot. It runs with the user's own rights,
  so choose it only when a page cannot do the job. Start with the [native guide](docs/native.md) and the
  working example in [`examples/tap-meter`](examples/tap-meter/README.md).

The rest of this page, and the quick start below, describe the UI tier unless it says otherwise.

### What a plugin can do

- Show its own page inside Plisto, in the plugin's own frame.
- Add a row or a section to the sidebar, with links to its page, and with live items: a status line, a
  progress bar, a switch and a button.
- Keep its own small saved data (1 MiB).
- Write to its own log file.
- Show short toasts, ask the user to confirm something and put badges ("chips") on its sidebar row.
- Keep running in the background while the user looks at another page, if it asks for that.
- Exchange data with the sites it lists: HTTP requests, streamed responses, Server-Sent Events and
  sockets, all made by Plisto.
- Read the app's language, theme and mode, and hear when they change, along with what is playing, the
  queue and library changes.
- Read the user's library (titles, artists, albums, playlists and covers, never file locations) and what is
  playing, and control playback, each behind its own capability.
- A native plugin can also run its own program, read the audio Plisto plays, and hold Plisto's output.

Each of these beyond the basics is a capability that the user reviews before the plugin is turned on.

### What a plugin cannot do

- Reach the network by itself. The page's security policy blocks every request. With the `network`
  capability, Plisto makes requests for it to the sites it lists (see the network guide).
- Read the user's files, or anything in the library beyond what the `library.*` methods return.
- Touch Plisto's window, another plugin, or any browser storage (`localStorage`, cookies, IndexedDB).
  Saved data goes through `plisto.storage`.
- Run inline scripts, load scripts from a CDN, or use module scripts.
- Change the sidebar layout the manifest declares, or draw anything in Plisto's own interface. Toasts and
  prompts are drawn by Plisto, with the plugin's name on them.

Plisto does not review plugins. Users are told so when they install one.

## What is in the kit

| Path | What it holds |
| --- | --- |
| `README.md` | This page. |
| `docs/getting-started.md` | Build a first plugin from an empty folder. |
| `docs/manifest.md` | The `plugin.json` reference. |
| `docs/api.md` | The API reference: every method, error code, event and SDK member. |
| `docs/bridge.md` | The messages between a plugin page and Plisto, for a page that does not use the SDK. |
| `docs/limits.md` | Every limit in one place: frames, rates, logs, storage, install, streams and network. |
| `docs/ui-surfaces.md` | Toasts, prompts, chips, the prompt gate, opening your page, and what the page frame can load and do. |
| `docs/sidebar.md` | The sidebar declaration and live items. |
| `docs/network.md` | Network access: origins, fetch, streams, Server-Sent Events, sockets, limits and errors. |
| `docs/stream.md` | Playing audio through Plisto: pull and push, formats, metadata, events, every end reason and limit. |
| `docs/events.md` | App events: what is playing, the transport, the queue, library changes, theme, language and mode, with every payload, the pace and a recipe to follow the play head. |
| `docs/native.md` | The native tier: manifest, launch, the wire protocol, the audio tap and feed, output takeover. |
| `docs/lifecycle.md` | Install, enable, update, heartbeat, background plugins, crashes, what a plugin's row says, safe mode, logging, versioning and the SDK changelog. |
| `docs/install-and-test.md` | Packing and installing into Plisto, testing, debugging and a release checklist. |
| `sdk/plisto-sdk.js` | The SDK. Copy it into your plugin folder. |
| `sdk/plisto-sdk.d.ts` | TypeScript types for the SDK. |
| `sdk/mock-host.html` | A mock host page: develop a UI plugin's page in a browser with no Plisto running. Served by `sdk/mock-serve.mjs`. See [getting started](docs/getting-started.md#develop-in-a-browser-with-the-mock-host). |
| `tests/net-sdk.mjs` | Tests of the SDK's network code. |
| `tests/plugin-sdk.mjs` | Tests of the SDK's native-plugin half. |
| `tests/stream-sdk.mjs` | Tests of the SDK's stream helpers and `pushFrom`'s back-pressure. |
| `tests/events-sdk.mjs` | Tests of the SDK's app event helpers and their routing. |
| `tests/mock-host.mjs` | Checks that every SDK method has a handler in the mock host or is listed there as not implemented (the `net.*` methods). Run all five with `node --test tests/*.mjs`. |
| `examples/pack.ps1` | Packs any plugin folder (`-Path`), or the samples `hello-ui` and `hello-background`, into an installable `.plistoplugin` file. |
| `examples/hello-ui/` | A page plugin that exercises toasts, prompts, chips and routes. |
| `examples/hello-background/` | A background plugin with a sidebar section of live items. |
| `examples/tap-meter/` | A native plugin in Rust, with a page: the starting point for the native tier. |

## The shortest path to a running plugin

1. Make a folder, for example `my-plugin`.
2. Copy `sdk/plisto-sdk.js` into it.
3. Add a `plugin.json` and an `index.html` (the next page shows both, about 25 lines in all).
4. In Plisto, open Settings > Plugins, choose Install from folder and pick your folder.
5. Review what it asks for, press Install, then turn its switch on.
6. Click its row in the sidebar. Your page opens.

To skip the typing, install `examples/hello-ui` the same way and read its code.

## Where to read next

- [Getting started](docs/getting-started.md) walks through the steps above with real files.
- [Manifest reference](docs/manifest.md) lists every `plugin.json` field and limit.
- [API reference](docs/api.md) is the page to keep open while you code. [Limits](docs/limits.md) gathers
  every number, and the [bridge reference](docs/bridge.md) covers a page that talks to Plisto without the SDK.
- [Getting started](docs/getting-started.md#develop-in-a-browser-with-the-mock-host) also shows how to try a
  page in a browser with the mock host before you install it.
- [Install and test](docs/install-and-test.md) covers debugging and what to check before you hand a plugin
  to someone else.
- [Native plugins](docs/native.md) is the guide for the native tier. Read it with
  [`examples/tap-meter`](examples/tap-meter/README.md) open beside it.
