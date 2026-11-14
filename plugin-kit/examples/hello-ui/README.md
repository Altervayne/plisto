# Hello UI

A page plugin (`dev.plisto.hello-ui`) that shows the SDK working: a counter saved with `storage.set`, the
`app.info` fields, and a `has("library.tracks")` check. Each counter click writes a line with `log.info`. It
asks for `storage`, `library.read`, `playback.read`, `playback.control`, `ui.toast`, `ui.confirm` and
`ui.chips`.

Results appear in the Results list, newest first.

The Library and playback card reads your library and changes the queue:

- **List five tracks** lists the first five tracks by title, with `library.tracks`.
- **Show a grid cover** shows the cover of the first album by title at the grid size, with
  `library.albums` and `library.cover`.
- **Play an album next** puts that same album after the playing track, with `queue.play_next`. If nothing
  is playing, Plisto starts it.
- **Now playing** shows the playing track from `playback.state`.

Each UI surface has buttons too.

- **Toast** shows a plain toast.
- **Toast with action** shows a toast with a Details button. Pressing it logs that a gesture arrived, then
  opens the route `details` with it.
- **Flood 10 toasts** fires ten at once. Three are accepted; the rest show `rate_limited` or `busy`.
- **Confirm** raises a prompt and shows the answer.
- **Confirm twice** fires two prompts at once; the second shows `busy`.
- **Set chips** puts `3 devices` and a `2` chip in the plugin's sidebar row. **Long chip** sets one long
  warn chip, which the row truncates. **Clear chips** removes them.
- **Flood chips 30 in 1 s** shows the first refusal.
- **Go to settings route** calls `openPage("settings")`. The page is open, so no gesture is needed. The
  Route line follows `plisto.route` through `plisto.on("route")`.

Three buttons misbehave on purpose, to test how Plisto treats a page that stops answering:

- **Busy for 8 s** freezes the page's own thread. Plisto shows the not-responding card after about 5 s;
  the page recovers when the loop ends.
- **Busy for 20 s** freezes it long enough to be stopped after about 15 s. Plisto shows the crash card;
  Restart brings the page back.
- **Navigate away** loads the page's own `index.html` again, which counts as a crash.

## Install

1. In Plisto, open the plugin hub and install from a folder (Settings > Plugins): choose this `hello-ui` folder.
2. Turn the plugin on. It appears in the sidebar under its own name.

Updating from an earlier version adds capabilities, so Plisto asks for consent again: review the new
capabilities (`ui.toast`, `ui.confirm` and `ui.chips` since 1.1.0; `library.read`, `playback.read` and
`playback.control` since 1.2.0) and approve them before the plugin runs.

## Remove

Open the plugin hub, uninstall Hello UI, and tick the box to delete its data if you want the saved counter
gone too.

`plisto-sdk.js` here is a copy of `../../sdk/plisto-sdk.js`. Keep the copies identical. The guides are in `../../docs/` (start with `../../README.md`).
