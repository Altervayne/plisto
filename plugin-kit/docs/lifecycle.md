# Lifecycle

This page explains what happens to a plugin from install to uninstall: how Plisto installs it, who turns it
on, where it shows up, how updates and the manifest hash work, how Plisto watches a running page, and what
happens on a crash or in safe mode. It also covers logging and API versioning. Hands-on steps are in
[install and test](install-and-test.md).

## Install

A plugin comes to Plisto as a **folder** or as a **`.plistoplugin` file**, which is a plain zip archive of
the folder. Plisto never runs or changes the source. It copies the plugin into its own plugins folder.

Install has two steps. First Plisto inspects the source: it copies it into a staging area and checks it.
Then, when the user confirms the review sheet, it moves the plugin into place.

What is checked:

- `plugin.json` is present, valid and no larger than 64 KiB (see the [manifest reference](manifest.md)).
- The manifest `id` is not already installed. An installed id is handled as an update (below).
- The entry file exists, and so does the icon if there is one. Both must be plain files inside the folder.
- The manifest does not need a newer Plisto than the one running.
- File and path rules: no more than 4,096 files, no more than 256 MiB in total, folders no deeper than 16
  levels, no path over 200 characters, and no installed path over 240 characters. Paths use the characters
  `A-Z a-z 0-9 . _ -` and no Windows device names.
- No links or shortcuts, no hidden file streams (the `Zone.Identifier` mark Windows adds to downloaded
  files is dropped), and names that would clash on Windows are refused.
- An archive may hold `plugin.json` at its root or inside exactly one top-level folder, which Plisto
  strips. It must be at most 256 MiB, with no encrypted members.

A failed check refuses the plugin with a message and installs nothing.

### The inbox

Settings > Plugins has an Open plugins folder button. It opens the inbox. A folder or a `.plistoplugin`
file dropped there appears under Available to install, with a Review button. Nothing in the inbox runs
until the user reviews and installs it.

### The review sheet

Before anything is installed the user sees a sheet with the plugin's name, author (shown as declared and
not verified), version and the capabilities it asks for, in plain language. Installing means approving
exactly that manifest.

A plugin installs **turned off**. The user turns it on with the switch on its row in Settings > Plugins.
Nothing from the plugin runs before that.

## Turning it on and off

The switch in Settings > Plugins enables or disables a plugin. Enabling checks the folder again first. A
disabled plugin runs nothing: no page, no background page, no sidebar entry. Its files and saved data stay.

A plugin that is **off until reviewed** shows a Review button instead. This happens when:

- the user has not approved it yet (for example a plugin found in the inbox or its folder);
- its `plugin.json` changed since the user approved it, whatever the change; or
- an update asks for more than the user approved.

Do not edit files in an installed plugin's folder. A changed manifest returns the plugin to "needs
review" and turns it off. Reinstall instead.

## Where a plugin appears

- **Sidebar.** A plugin that is enabled, healthy and visible in the current app mode has a row or a
  section in the plugins zone. See the [sidebar guide](sidebar.md). The user can fold a section but cannot
  rearrange it.
- **Plugin page.** Clicking the row or a nav item opens the plugin's page in Plisto's main area, under a
  header with the plugin's name. While the page starts, Plisto shows a "Starting" card.
- **Finder.** The finder lists each plugin. For a section it lists each nav item as "Plugin: Item".
- **Settings > Plugins.** Every installed plugin has a row: icon, name, version, state and a switch. An
  expandable panel shows its permissions, author, website, the size of its saved data and buttons for
  Disable and Uninstall. For an enabled plugin with a page there is also an Open settings button, which
  opens your page at the route `settings`. A plugin that is hidden in the current app mode is still
  listed here.

## Updates and the manifest hash

To update, install a newer folder or file with the same `id`. Plisto sees that the id is installed and
offers an update on the review sheet.

- The new version replaces the old one. Saved data is kept.
- A tier change is refused: uninstall the plugin, then install the new one.
- Going to an older version is allowed.
- If the new manifest asks for exactly the same capabilities as the user approved, the plugin stays on and
  keeps its approval. If it asks for anything different, the plugin stays off and the sheet asks again,
  marking what is new. The update is not lost: it is installed and waits for approval.
- During an update the plugin stops. Its pages and background page restart on the new version, and its
  live sidebar state is cleared, so send it again at start.
- If the swap fails, Plisto puts the old version back.

Plisto records a hash of the manifest the user approved. At every start it compares the file on disk with
that hash. A different manifest returns the plugin to "needs review".

## Uninstall

Uninstalling removes the plugin's folder. The user chooses whether to delete its saved data too. If the
box is not ticked, a reinstall finds the data again. The user's library and source folders are never
touched.

## The life of a page

A plugin without the `background` capability has a **page frame**. Plisto starts it when the page opens
and stops it when the page closes. Whatever your page held in memory is gone, so keep what matters in
`plisto.storage`. Opening it again starts it fresh.

The frame is its own world: it has its own origin, cannot reach Plisto's window or another plugin, and its
security policy allows only scripts, styles, images and fonts from your own folder, and `blob:` images.
Network access goes through Plisto and needs the `network` capability (see the [network guide](network.md)). Plisto does not run
frames while the library is empty.

Your page receives `plisto.ready` when Plisto has initialised it. Wait for it before reading `info`.

## The heartbeat

Plisto pings every page once a second. The SDK answers from its message listener, so you do nothing, as
long as your page's main thread is free.

| Silence from the page | What Plisto does |
| --- | --- |
| About 5 seconds | Shows a "not responding" card over the page, with Wait and Disable. |
| About 15 seconds | Stops the page and shows a crash card with Restart and Disable. |

The clock starts when the frame is mounted, so a page that never finishes loading also crashes. The
heartbeat pauses while Plisto's own window is hidden. Choosing Wait restarts both timers.

A page also counts as crashed if it loads a new document, a reload included. Hash changes are safe.
Plisto's window is never slowed by a busy plugin page.

So keep the main thread free: no long synchronous loops, and do heavy work in chunks. The hello-ui
example has buttons that block the thread on purpose to show both cards.

## Background plugins

A plugin with the `background` capability keeps its page running after the user leaves it.

- It starts after Plisto starts, one background plugin at a time, in install order, a couple of seconds
  apart. Opening its page starts it at once.
- It stays alive across navigation and app mode changes. It stops when it is disabled, uninstalled,
  updated, crashed or when Plisto quits.
- A background page with no visible page is still pinged. If it hangs or crashes, the plugin's sidebar
  entry shows a warning mark instead of a card.
- Use timers for periodic work. `requestAnimationFrame` stops in a hidden frame.
- While Plisto's window is hidden or minimized, the browser slows timers in every page and the heartbeat
  pauses. Do not rely on precise timing.
- Every page costs memory. Keep it small. Its budgets are shared with the plugin's other pages.
- Listen to `plisto.on("visibility")` to know when your page is the one on screen.
- Plisto does not start background plugins while the library is empty.
- A background page may call `ui.toast`, `ui.chips`, `ui.sidebar.update` and `log.write`. A prompt or
  `openPage` from a background page needs a gesture (see [UI surfaces](ui-surfaces.md)).

## Crashes

A crash happens when the page is silent for about 15 seconds, or loads a new document, or Plisto could not
start it. Plisto stops the page, discards its live sidebar state and open toasts and prompts, and shows a
card: "stopped unexpectedly", with a Show details line giving the reason, and Restart. Plisto itself keeps
running.

A crash stays until the user presses Restart, disables the plugin or updates it. Plisto does not restart
the page on its own. Restart starts it fresh, as a new page.

## Safe mode

Plisto can start in safe mode, which starts no plugin: no page frame, no background page, no live sidebar
state, and no toast or prompt. Plisto ignores the plugin's calls because nothing is running. Settings >
Plugins still works, so a user can disable or uninstall a plugin that causes trouble. Plisto also records
whether the previous run ended uncleanly. Nothing in the plugin has to handle safe mode.

## Logging

`plisto.log.debug/info/warn/error(text)` writes one line to the plugin's log file.

- A line reads `<unix milliseconds> <LEVEL> <text>`, with the level in capitals.
- Control characters in the text become spaces, and the text is cut to 2,048 bytes.
- The file is `plugin.log` in `plugins-data\<plugin id>\` inside Plisto's app data folder, which on
  Windows is `%APPDATA%\com.altervayne.plisto\`.
- At 262,144 bytes the file is renamed to `plugin.log.1`, replacing the older copy, and a new file
  starts.
- Lines written by Plisto itself about your plugin carry the level `HOST`. A plugin cannot write that
  level.
- Log to find your own bugs. Do not log secrets or personal data.

Log calls cost an API call each and are rate limited (a burst of 40, then 10 per second). Do not log in a
tight loop.

## Versioning

- `app.info().api_version` is `1`. Within a version, methods and result fields are only added, never
  removed or changed in meaning. Ignore result fields you do not know. A removal or a change of meaning
  raises `api_version`.
- The SDK has its own `sdkVersion`, currently `1.4.0`. A newer SDK is a drop-in replacement: copy the new
  `plisto-sdk.js` over yours.
- Your plugin's `version` is semantic versioning. Raise it for every release, or Plisto cannot tell an
  update from a reinstall.
- Use `min_plisto` to say which Plisto you need. Plisto refuses to install or turn on a plugin that needs
  a newer one.
- To use a method an older Plisto may lack, check `plisto.has("name")` first.
