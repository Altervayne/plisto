# Lifecycle

This page explains what happens to a plugin from install to uninstall: how Plisto installs it, who turns it
on, where it shows up, how updates and the manifest hash work, how Plisto watches a running page, what the plugin's row says in each
state, and what happens on a crash or in safe mode. It also covers logging and versioning. Hands-on steps are in
[install and test](install-and-test.md).

## Install

This page describes a page plugin. A native plugin follows the same install, review, update and uninstall
steps, but its program, not a page frame, is what runs: see the [native guide](native.md) for how it
starts, stops and restarts.

A plugin comes to Plisto as a **folder** or as a **`.plistoplugin` file**, which is a plain zip archive of
the folder. Plisto never runs or changes the source. It copies the plugin into its own plugins folder.

Install has two steps. First Plisto inspects the source: it copies it into a staging area and checks it.
Then, when the user confirms the review sheet, it moves the plugin into place.

What is checked:

- `plugin.json` is present, valid and no larger than 64 KiB (see the [manifest reference](manifest.md)).
- The manifest `id` is not already installed. An installed id is handled as an update (below).
- The entry file exists, and so does the icon if there is one. Both must be plain files inside the folder.
- The manifest does not need a newer Plisto than the one running.
- File and path rules: no more than 4,096 files, no more than 256 MiB in total, a path of at most 16
  parts, the file name included, no path over 200 characters, and no installed path over 240 characters. A path has no control
  character and none of `: < > " | ? *`, no part ending in a dot or a space, no Windows device name and no
  8.3 short name such as `PROGRA~1`. The install is wider than what Plisto serves to a page: see
  [UI surfaces](ui-surfaces.md#files-plisto-serves).
- No links or shortcuts, no hidden file streams (the `Zone.Identifier` mark Windows adds to downloaded
  files is dropped), and names that would clash on Windows are refused.
- An archive may hold `plugin.json` at its root or inside exactly one top-level folder, which Plisto
  strips. It must be at most 256 MiB, with no encrypted members, no entry named twice (names that differ
  only in case count as one) and entry names written with forward slashes: a name with a backslash is
  refused. Only stored and deflate compression are read. See
  [install and test](install-and-test.md#pack-your-plugin) for a script that writes a correct archive.

Where the installed copy lives: `%APPDATA%\com.altervayne.plisto\plugins\<id>\` (the app identifier is
`com.altervayne.plisto`). Its saved data, logs and, for a native plugin, the program's own files are in
`%APPDATA%\com.altervayne.plisto\plugins-data\<id>\`. Do not write into the first folder: an update replaces
it.

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
- an update changes what the user approved: see the next section.

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
- Consent is kept only when everything the review sheet shows is unchanged. Plisto compares the
  capabilities, the `network` origins and `native_reason` of the installed manifest with the new one, and
  the capabilities the user approved with the new list. A capability added or removed, an origin added or
  removed, or a different `native_reason` all ask again: removing a capability asks too, not only adding
  one. A change to `name`, `version`, `author`, `homepage`, `icon`, `modes` or the sidebar block asks for
  nothing. It also asks again when the installed manifest no longer matches the hash the user approved, or
  the installed plugin was waiting for review. Then the plugin stays off and the sheet asks again, marking
  what is new. The update is not lost: it is installed and waits for approval. When consent is kept, the
  plugin keeps its approval and its on or off state.
- During an update the plugin stops. Its pages and background page restart on the new version, and its
  live sidebar state is cleared, so send it again at start.
- If the swap fails, Plisto puts the old version back.

Plisto records a hash of the manifest the user approved. At every start it compares the file on disk with
that hash. A different manifest returns the plugin to "needs review".

## Uninstall

Uninstalling removes the plugin's folder. The user chooses whether to delete its saved data too. If the
box is not ticked, a reinstall finds the data again. With the box ticked, Plisto removes the whole
`plugins-data\<id>\` folder: the saved data, `plugin.log` and `plugin.log.1`, and for a native plugin
`stderr.log`, the program's own files and the web view profile in `webview2`. A native plugin stops first.
The user's library and source folders are never touched.

## The life of a page

A plugin without the `background` capability has a **page frame**. Plisto starts it when the page opens
and stops it when the page closes. Whatever your page held in memory is gone, so keep what matters in
`plisto.storage`. Opening it again starts it fresh.

The frame is its own world: it has its own origin, cannot reach Plisto's window or another plugin, and its
security policy allows only scripts, styles and fonts from your own folder, and images from your folder,
`data:` and `blob:`. Plisto serves only 16 file extensions from your folder. The policy has no media,
worker, frame or network source, and the sandbox is `allow-scripts` only. The whole rule is in
[UI surfaces](ui-surfaces.md#what-the-page-frame-allows). Network access goes through Plisto and needs the
`network` capability (see the [network guide](network.md)).

No plugin page opens while Plisto shows its first-run or empty-library screen (no folder added yet, or no
tracks): the shell that hosts frames is not on screen then. A native
plugin's program is not held back by this: Plisto starts it at launch whatever the library holds, and only
its page waits.

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
  updated, crashed or when Plisto quits. Closing Plisto's window does not quit it when the close-to-tray
  setting is on: the window only hides, Plisto keeps running behind its tray icon, native programs keep
  running, and background pages stay loaded, with the slowed timers described below. Plisto quits when the process exits: the close button with close-to-tray
  off, or Quit in the tray menu. Both ask first when a running job would lose work.
- A background page with no visible page is still pinged. If it hangs or crashes, the plugin's sidebar
  entry shows a warning mark instead of a card.
- Use timers for periodic work. `requestAnimationFrame` stops in a hidden frame.
- While Plisto's window is hidden or minimized, the browser slows timers in every page and the heartbeat
  pauses. Do not rely on precise timing.
- Every page costs memory. Keep it small. Its budgets are shared with the plugin's other pages.
- Listen to `plisto.on("visibility")` to know when your page is the one on screen.
- No page opens while Plisto shows its first-run or empty-library screen (see "The life of a page").
- A background page may call `ui.toast`, `ui.chips`, `ui.sidebar.update` and `log.write`. A prompt or
  `openPage` from a background page needs a gesture (see [UI surfaces](ui-surfaces.md)).

## Crashes

A crash happens when the page is silent for about 15 seconds, or loads a new document, or Plisto could not
start it. Plisto stops the page, discards its live sidebar state and open toasts and prompts, and shows a
card: "stopped unexpectedly", with a Show details line giving the reason, and Restart. Plisto itself keeps
running.

A crash stays until the user presses Restart, disables the plugin or updates it. Plisto does not restart
the page on its own. Restart starts it fresh, as a new page.

## What the user sees on a plugin's row

Settings > Plugins shows one status line on each plugin's row. These are the lines, in English, with what
causes each and what to check when your plugin lands on it.

| The row says | What caused it | What to check |
| --- | --- | --- |
| Off | The user has not turned it on, or turned it off. | Nothing. A new install is always here first. |
| On, or Runs in the background | It runs. A native program's own `status` text replaces this line while it runs. | Nothing. |
| Starting | It was just turned on, restarted or updated. A page: until it answers its first heartbeat. A program: until it sends `ready`, within 10 seconds. | A page that stays here never loads `plisto-sdk.js`, which answers the heartbeat. A program that stays here is slow before `ready`: send `ready` first and start slowly after. |
| Not responding | A page was silent about 5 seconds. A program sent no valid `pong` for 3 seconds. Plisto never kills it for this. | A blocked main thread (page) or a reader thread that waits on something slow (program). See the [ping rule](native.md#the-ping-rule). A program that held the output loses it at that moment. |
| Restarting after it stopped unexpectedly | A native program crashed. Plisto starts it again after 1, then 2, then 4 seconds. | `stderr.log`. See [crashes and restarts](native.md#crashes-and-restarts). |
| Stopped unexpectedly | A page was silent for 15 seconds, loaded a new document, or Plisto could not start it. It waits for the user. | The Show details line names the reason. See "Crashes" above. |
| Stopped unexpectedly 3 times within a minute, so Plisto turned it off | Three crashes inside 60 seconds. The plugin is off. | The log, then fix the cause. The user turns it on again with its switch. |
| Could not start: its files are not valid | The folder no longer passes the install checks. | Reinstall from a clean folder or archive. |
| Could not start: its files changed since you approved it | `plugin.json` on disk is not the one the user approved. | Never edit an installed copy. Reinstall. |
| Could not start: Windows would not let it launch | Windows refused the program. See "When antivirus blocks the program" below. | The user's antivirus or policy, not your code. |
| Off until you review it | The plugin is waiting for review: not approved yet, changed since, or an update asks for more. | The user presses Review. |
| Broken: followed by a reason, or Broken. Plisto could not read its files. | The installed files are damaged or a file the manifest names is missing. | Reinstall. |
| Needs Plisto X or newer. You have Y. | `min_plisto` is newer than the running Plisto. | Lower `min_plisto` only if you tested on the older version. |
| Plisto could not read its details. | The manifest could not be read. | Reinstall. |
| Off for this session | Plisto is in [safe mode](#safe-mode): nothing runs. | The user restarts Plisto normally. |

While Plisto stops a plugin to swap in an update, its open page reads Starting and the row says nothing new.

A **Restart** button shows on the row, in the plugin's expanded panel, for a native program while it runs, for
a plugin that is not responding and for a page that stopped unexpectedly. Restart starts a page fresh, as a
new page, and a program as a new process (`hello` again, with nothing carried over). It is not shown while a
plugin starts, restarts by itself or could not start. A page that is open also carries Restart on its crash
card.

### When antivirus blocks the program

If Windows refuses to run the program, Plisto does not retry. The row says "Could not start: Windows would
not let it launch", and the plugin's page area says it could not start. Plisto reads this from an access
denied error, and from the Windows error codes 225 (the file holds a virus or unwanted software), 226 (the
file was removed as one) and 1260 (a policy blocks the program). The program never runs, so `stderr.log` has
nothing. The user must allow the program in the antivirus or the policy and turn the plugin off and on again.
A first start that is only slow, because a scan holds the file, is not this: Plisto allows 10 seconds to
`ready` for that reason. As an author, test the final `.exe` on a machine with a default Windows Defender
before you ship it.

## Event subscriptions

A subscription to app events (see the [events guide](events.md)) lives in memory and ends with whatever
carried it:

- **A page's set** ends when the page goes: it is closed, reloaded, restarted or crashes. A page that starts
  again subscribes again after `plisto.ready`.
- **A native program's set** ends when its run ends: a crash, a restart or a stop. The program subscribes
  again after `ready`. The page's set is not touched.
- **Both sets** end when the plugin is disabled, uninstalled, updated or needs approval again, and in safe
  mode.
- **One topic** ends when the plugin loses the grant behind it.

Nothing is replayed after a subscription ends: the next subscribe answers with the current values.

## Safe mode

Safe mode is a session in which no plugin runs: no page frame, no background page, no native program, no
live sidebar state, and no toast or prompt. Settings > Plugins still works, so a user can disable or
uninstall a plugin that causes trouble. Nothing in the plugin has to handle safe mode.

How a session gets there:

- **After an unclean exit.** Plisto leaves a marker while it runs and removes it on a clean exit. When it
  starts and finds the marker, the last run ended uncleanly (a crash, a kill, a power cut). If at least one
  enabled plugin would run, Plisto starts nothing and offers: "Plisto closed unexpectedly while plugins were
  running. This may be related to a plugin. Start without plugins?" with Start normally and Start without
  plugins. Plugins stay off until the user answers. A marker left by another Plisto version, as an update
  leaves, is not counted. With no enabled plugin there is no offer.
- **By choice.** Settings > Plugins has a Safe mode row with Restart without plugins. It stops every
  plugin, restarts Plisto and starts the new session with plugins off.

Either way the choice covers this session only, not a setting. The Plisto window shows "Plugins are off for
this session" with Restart normally, the Safe mode row then reads Restart normally, and every row reads "Off
for this session". The next launch starts plugins as usual. Nothing is uninstalled or disabled, and no data
is touched.

What each tier sees:

| Part of a plugin | In safe mode |
| --- | --- |
| A page or background page | Never starts. |
| A native program | Never starts. If safe mode begins while it runs (the user answers the offer with Start without plugins), Plisto stops it, and gives back the output it held with reason `stopped`. |
| `events.subscribe` | `unavailable`. Both subscription sets end. |
| A playing stream | Ends with `plugin_gone` and detail `safe_mode`. Plisto tells the user "Plugins are off for this session, so the plugin's stream stopped." |
| Sidebar rows, toasts, prompts | None. |

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
tight loop. A native program's `log` messages draw from the same bucket as the page's `log.write`, so the
page and the program share one burst of 40 and one 10 per second; a line over the limit is dropped and
counted, with no answer. A program's text is cut to 2,000 characters first, then to the same 2,048 bytes.
Every number is in [limits](limits.md).

## Versioning

Six numbers are in play. This is the whole policy.

| Number | Where it lives | Rule |
| --- | --- | --- |
| `manifest_version` | `plugin.json` | `1` is the only value. Any other is refused (`unsupported manifest_version`). Unknown fields are ignored, so Plisto can add optional fields without raising it. A change that breaks an existing manifest would raise it. |
| `api_version` | `app.info().api_version`, and `hello` | `1`. Within a version, methods and result fields are only added, never removed or changed in meaning. Ignore result fields you do not know. A removal or a change of meaning raises `api_version`. |
| `hello.protocol`, `ready.protocol` | The native wire protocol | `1`. Adding a message type or a field does not raise it: both sides ignore what they do not know. A change to the frame format or to what a message means would. A program answers `ready` with the protocol it speaks. If it speaks another one than Plisto's, Plisto kills it and the start fails. A program that finds a `hello.protocol` or a `--plisto-protocol` argument other than the one it speaks should exit without sending `ready`, as tap-meter does for the argument. |
| `layout_version` | The audio tap header | `1`. A change to the header, the records or the sample ring would be a new layout version. A reader must refuse a mapping whose version, capacity or segment count it does not know. |
| `sdkVersion` | `plisto.sdkVersion` | The SDK's own number, currently `1.4.0`. A newer SDK is a drop-in replacement: copy the new `plisto-sdk.js` over yours. It does not depend on a Plisto version: it calls only what Plisto lists, and `plisto.has` tells you what that is. |
| Your `version` | `plugin.json` | Semantic versioning. Raise it for every release, or Plisto cannot tell an update from a reinstall. |

- `min_plisto` says which Plisto you need. Plisto refuses to install or turn on a plugin that needs a newer
  one. Set it to the lowest Plisto version you tested the plugin on. The plugin system first ships in
  Plisto 2.7.0, and the stream and app event methods (`stream.*`, `events.subscribe`) need 2.7.0 or newer,
  so a plugin that uses them says `"2.7.0"`. The examples in this kit keep `"2.6.0"` because they were
  built and run against pre-release builds that report 2.6.x; see the
  [manifest reference](manifest.md#version-and-min_plisto).
- To use a method an older Plisto may lack, check `plisto.has("name")` first.

### SDK changelog

The SDK file carries the version in `sdkVersion`. This is what each version added, from the kit's history.
Version 1.4.0 is still the number on the file after the later additions below, so compare behaviour with
`plisto.has` and not with the version string.

- **1.1.0.** The first release: `plisto.call`, `ready`, `info`, `has`, `on` (`theme`, `visibility`, `route`,
  `sidebar`), and the helpers for `app`, `storage`, `log` and `ui` (toast, confirm, chips, sidebar update,
  open page).
- **1.2.0.** The `library`, `playback` and `queue` helpers, including `library.cover`.
- **1.3.0.** The network helpers: `net.fetch`, `net.eventSource`, `net.imageUrl`, `net.revoke` and
  `net.socket`.
- **1.4.0.** The native plugin half: `plisto.plugin.call` and `plisto.onPluginEvent`.
- **Added after 1.4.0 without a new number.** The stream helpers (`stream.*`, `stream.pushFrom`,
  `plisto.onStream`), then the app event helpers (`events.subscribe`, `events.on`, `events.topics`). A
  copy of `plisto-sdk.js` that predates them lacks these members: check `plisto.events` or `plisto.stream`
  exists, or copy the current file.
