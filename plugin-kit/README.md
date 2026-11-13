# Plisto plugin kit

This kit has what you need to build a Plisto plugin: guides, the API reference, the SDK and two working
example plugins. Start here, then follow the links.

## What a Plisto plugin is

A plugin adds a page to Plisto, and can add entries to the sidebar. It is a folder of web files: an HTML
page, scripts, styles and a `plugin.json` that describes it. Plisto runs the page in a sandboxed frame and
the page talks to Plisto through a small API.

There are two tiers of plugin. This kit covers the **UI tier**, a sandboxed web page. A native tier (a
program that runs on its own) is planned and is not available yet.

### What a plugin can do

- Show its own page inside Plisto, in the plugin's own frame.
- Add a row or a section to the sidebar, with links to its page, and with live items: a status line, a
  progress bar, a switch and a button.
- Keep its own small saved data (1 MiB).
- Write to its own log file.
- Show short toasts, ask the user to confirm something and put badges ("chips") on its sidebar row.
- Keep running in the background while the user looks at another page, if it asks for that.
- Read the app's language, theme and mode.

Each of these beyond the basics is a capability that the user reviews before the plugin is turned on.

### What a plugin cannot do

- Reach the network. The page's security policy blocks every request to an outside address.
- Read the user's files or library. No method for library data or playback control exists yet.
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
| `docs/ui-surfaces.md` | Toasts, prompts, chips, the prompt gate and opening your page. |
| `docs/sidebar.md` | The sidebar declaration and live items. |
| `docs/lifecycle.md` | Install, enable, update, heartbeat, background plugins, crashes, safe mode, logging, versioning. |
| `docs/install-and-test.md` | Installing into Plisto, testing, debugging and a release checklist. |
| `sdk/plisto-sdk.js` | The SDK. Copy it into your plugin folder. |
| `sdk/plisto-sdk.d.ts` | TypeScript types for the SDK. |
| `examples/hello-ui/` | A page plugin that exercises toasts, prompts, chips and routes. |
| `examples/hello-background/` | A background plugin with a sidebar section of live items. |

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
- [API reference](docs/api.md) is the page to keep open while you code.
- [Install and test](docs/install-and-test.md) covers debugging and what to check before you hand a plugin
  to someone else.
