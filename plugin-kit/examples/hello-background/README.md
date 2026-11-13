# Hello background

A background plugin (`dev.plisto.hello-bg`) with a sidebar section. Its page keeps running while Plisto
shows another page. A one second timer counts up (a timer, not `requestAnimationFrame`, which stops in a
hidden frame), the count is saved with `storage.set` every 5 seconds, and the page shows the count,
whether it is the open page, its route, and the theme.

It asks for `storage`, `background`, `ui.toast`, `ui.confirm`, `ui.chips` and `ui.sidebar`, and declares
six sidebar items, one of each type:

- `home` and `settings` (nav). `settings` opens the page at the route `settings`. `home` carries a chip
  with the saved count.
- `state` (status): `Count N` every second, in the warn tone when N is a multiple of 20.
- `work` (progress): fills from 0 to 1 over 10 seconds, then sweeps (indeterminate) for 10 seconds, and
  repeats.
- `auto` (toggle): confirmed 500 ms after you press it. Tick "Ignore toggles" on the page and it never
  confirms: the switch dims for 3 seconds and stays where it was.
- `ping` (action): asks a prompt, using the click's gesture, then toasts the answer. Works with the page
  closed.

Gesture tests, on the page: **Ask without a click in 11 s** and **Ask with an old click** each wait 11
seconds and then ask for a prompt. Leave the page within those 11 seconds: while the page is open, a prompt
needs no click. Both are refused with `denied` and the reason `no_gesture`; the status line shows
`Refused: no_gesture` and the page lists it under Last refusal. Press Ping in the sidebar before the old
click test so there is a click to be old. Every refusal is also written to the plugin's log.

**Busy for 20 s** freezes the page's own thread. Plisto stops it after about 15 s and marks the plugin in
the sidebar; its page then shows the crash card with a Restart button.

## Install

1. In Plisto, open the plugin hub and install from a folder (Settings > Plugins): choose this `hello-background` folder.
2. Turn the plugin on. Read the capability review: it asks for `storage`, `background`, `ui.toast`,
   `ui.confirm`, `ui.chips` and `ui.sidebar`. Updating from version 1.0.0 adds the last four, so Plisto
   asks for consent again.

## Remove

Open the plugin hub, uninstall Hello background, and tick the box to delete its data if you want the
saved count gone too.

`plisto-sdk.js` here is a copy of `../../sdk/plisto-sdk.js`. Keep the copies identical. The guides are in `../../docs/` (start with `../../README.md`).
