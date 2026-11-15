# Install and test

This page shows how to install a plugin into Plisto, how to test and debug it, and what to check before
you give it to someone else. For what Plisto does at each step, see [lifecycle](lifecycle.md).

## Install from a folder

1. Put your files, `plugin.json` and a copy of `plisto-sdk.js` in one folder.
2. In Plisto, open Settings > Plugins and choose Install from folder.
3. Pick the folder. Plisto inspects it and shows the review sheet with the capabilities the plugin asks
   for.
4. Press Install. The plugin appears in the list turned off.
5. Turn its switch on.
6. Click its row in the sidebar. Plisto shows a short "Starting" card until the page answers its first
   heartbeat, then your page.

If Plisto refuses the folder, the message says why. The [manifest reference](manifest.md) lists the
causes.

A native plugin installs the same way. Its review sheet is heavier, and its program starts when you turn
it on. See the [native guide](native.md), and [`examples/tap-meter`](../examples/tap-meter/README.md) for
packing, installing and where its logs are.

## Install from a file

A `.plistoplugin` file is a zip archive of your plugin folder with the extension changed. `plugin.json`
may be at the root of the archive or inside one top-level folder. Use Install from file in Settings >
Plugins, or drop the file into the plugins folder that the Open plugins folder button opens and press
Review on its entry. Use plain zip compression (stored or deflate); encrypted archives are refused.

## Pack a UI plugin

`examples/pack.ps1` builds the installable file for the two UI samples. From the `examples` folder:

```
powershell -File pack.ps1                  # hello-ui and hello-background
powershell -File pack.ps1 -Sample hello-ui # one sample
```

It writes `dist\<id>-<version>.plistoplugin` inside each sample: a zip with `plugin.json` at its root and
the files Plisto needs (the page, its scripts and styles, the icon and `plisto-sdk.js`), with no README and
no dotfiles. It refuses to pack when the sample's `plisto-sdk.js` is not byte-identical to
`sdk/plisto-sdk.js`; copy the kit's file over it and run again. Use it as a model for your own plugin: the
archive is the folder's files, nothing more. The native sample packs with its own
[`pack.ps1`](../examples/tap-meter/README.md).

Before you install, you can try the page in a browser with the [mock host](getting-started.md#develop-in-a-browser-with-the-mock-host).

## Update while developing

1. Change your files.
2. Raise `version` in `plugin.json`.
3. Install the folder again, as above. Plisto sees the same `id` and shows an update sheet.
4. If you did not change `capabilities`, the plugin stays on and the page restarts on the new version. If
   you added one, the plugin turns off and asks for approval: use Review, then approve it.

Your saved data survives updates. To start clean, uninstall the plugin and tick the box to delete its
data, or call `plisto.storage.clear()` from a debug button.

Do not edit the installed copy in place. A changed `plugin.json` turns the plugin off until it is
reviewed again.

## Developer mode

Developer mode is a switch at the foot of Settings > Plugins, under Safe mode. It is off by default and
stays as you leave it across restarts. It changes nothing about how a plugin is installed: the same
manifest checks, size limits and capability approval apply. While it is on:

- Plugins that list `http://127.0.0.1:<port>` or `http://localhost:<port>` can connect to that address.
  See the [network guide](network.md#developer-loopback-origins).
- Each plugin row shows two small buttons under its status line.
- A line under the switch tells you whether Plisto's sandbox check passed, and a log panel appears.

**Reload from source.** A plugin installed from a folder or a `.plistoplugin` file remembers where it came
from. Reload from source reads that folder or file again, runs every install check on it, and replaces the
installed copy the way an update does. Plisto never runs the plugin from your source folder: it reads the
copy it made. You do not need to raise `version` to reload.

- If `capabilities`, the `network` origins or the native reason changed, the plugin turns off and Plisto
  opens the review, as for an update. Approve it to turn the plugin back on.
- If the source is missing, fails a check, holds a different plugin `id`, or changes the `tier`, Plisto
  shows the same message as an install would and leaves the installed plugin as it was.
- A plugin that was added by copying files into the plugins folder has no remembered source, and its row
  has no Reload button. Install it once from a folder or a file.
- In safe mode the reload still copies the files, and the plugin stays off.

**Open log.** Opens the log panel on that plugin. The panel has one tab per installed plugin and shows
the last 200 lines of its `plugin.log` (time, level and text), and for a native plugin the last 200 lines
of its `stderr.log` below that. Plisto reads at most the last 64 KiB of each file, so a very long line
is cut at its start. The panel refreshes every couple of seconds while it is open.

**Sandbox check.** The line under the switch says "passed" or "not passed". Plisto runs the check at
every start. Until it passes, sandboxed plugins carry the Unsandboxed tag and use the heavier install sheet.

## Remove a plugin

Open Settings > Plugins, expand the plugin's row and press Uninstall. Tick "Also delete its saved data"
to remove its storage.

## Test checklist

Check these in the running app.

**Starting**
- The page opens from its sidebar row with no "not responding" or crash card.
- It works with no saved data (first run) and with saved data (second run).

**Themes and languages**
- Switch Plisto between light and dark. Text stays readable and no box appears behind the page. You set no
  `color-scheme`.
- Switch Plisto's language and check `info.locale` is what you expect. Plisto reports `en` or `fr`; any
  other language is reported as `en`.

**App modes**
- If `modes` is not set, the plugin shows in Player mode only. Check that is what you want.
- Switch the app mode and check the plugin appears and disappears as the manifest says.

**Heartbeat**
- No code runs for long on the main thread. Do heavy work in chunks.
- A background plugin shows no warning mark in the sidebar after running a few minutes.

**Errors**
- Each call that can fail has a `.catch` or a `try`. `rate_limited` is retried after `retryAfterMs`.
- `storage.get` handles a missing key with a fallback.
- A missing capability or a method an older Plisto lacks does not break the page. Use `plisto.has`.

**Sidebar**
- Every declared item shows, with the right label and icon.
- Toggles confirm or refuse clicks with `update`. They never stay dimmed.
- A click on an action works with your page closed (background plugins).

**Sandbox**
- The page loads nothing from outside its folder: no CDN, no remote font, no inline script, no module
  script.
- No `localStorage`, cookies or IndexedDB. Use `plisto.storage`.

## Debugging

**Read your log.** Every `plisto.log.*` call writes to `plugin.log` in
`%APPDATA%\com.altervayne.plisto\plugins-data\<plugin id>\`. Open it in any editor. Plisto notes its own
events about your plugin there with the level `HOST`, for example when it moves a damaged storage file
aside. The folder appears after the plugin first logs or stores something.

**Native plugins.** The program's standard error goes to `stderr.log` beside `plugin.log`, and is the
first place to look when a native plugin will not start. See the [native guide](native.md#logging).

**Show errors on the page.** While developing, catch errors from `plisto.call` and print `e.code`,
`e.reason` and `e.message` on screen or to the log. Codes are listed in the [API reference](api.md).

**Use the `reason`.** `denied` with `reason: "no_gesture"` means a prompt or page-open call had no open
page and no fresh gesture. `denied` without a reason means the capability is not in your manifest, or the
user has not approved it.

**Typical problems**

| Symptom | Likely cause |
| --- | --- |
| Plisto refuses the folder | A manifest rule is broken, or a file named in it is missing. |
| The plugin has no sidebar row | It is off, needs review, is incompatible, or its `modes` hide it in this app mode. |
| The page is blank and a script does not run | The script uses `type="module"`, or it is inline. Use a classic script with `src`. |
| A call rejects with `denied` | The capability is missing from `capabilities`, or the plugin was approved before you added it. |
| A call rejects with `unknown_method` | The method does not exist in this Plisto. Check `plisto.has`. |
| The page shows "not responding" | The main thread is blocked. Find the long loop. |
| The page shows a crash card | It was silent for 15 seconds, or it loaded a new document (a reload, `location` change or form post). |
| Styles are missing | The two `/_plisto/` sheets must be linked with absolute paths, as shown in [getting started](getting-started.md). |
| A font does not load | Do not rely on bundled web fonts. Use `var(--font-ui)`. |
| Saved data is gone after an update | The key names changed in your code, or the user deleted the data on uninstall. |

## Pre-release checklist

Before you hand a plugin to someone else:

- [ ] `id` is final and follows the rules. Changing it later makes a different plugin.
- [ ] `version` is higher than your last release.
- [ ] `min_plisto` names the oldest Plisto that has every method you call.
- [ ] `capabilities` lists only what you use. Every one is explained by the plugin's behavior.
- [ ] `name` is at most 40 characters and `author` is yours.
- [ ] `icon` is square (PNG at least 64 px) and under 256 KiB. `homepage` is `https`.
- [ ] `modes` says where the plugin should show.
- [ ] The folder holds the current `plisto-sdk.js` from the kit, and nothing else you do not need.
- [ ] Every file the page loads is in the folder. No external addresses, no inline script.
- [ ] You tested a first run, a second run, an update from your previous version, and an uninstall.
- [ ] You tested light and dark, and both languages if your page shows text from `info.locale`.
- [ ] The page never blocks the main thread. A background plugin has been left running for some time.
- [ ] Logs hold no secrets or personal data.
- [ ] You installed the final folder, or the final `.plistoplugin` file, from scratch in Plisto.

Then zip the folder, rename the zip to `<name>.plistoplugin` and share it. Tell users that Plisto asks
them to approve its capabilities when they install it.
