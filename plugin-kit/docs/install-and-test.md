# Install and test

This page shows how to install a plugin into Plisto, how to test and debug it, and what to check before
you give it to someone else. For what Plisto does at each step, see [lifecycle](lifecycle.md).

## Install from a folder

1. Put your files, `plugin.json` and a copy of `plisto-sdk.js` in one folder.
2. In Plisto, open Settings > Plugins and choose Install from folder.
3. Pick the folder. Plisto inspects it and shows the review sheet with the capabilities the plugin asks
   for.
4. Press Install. The plugin appears in the list turned off. If data from an earlier uninstall is still
   kept under your id, the sheet says so and offers "Delete that data before installing"; tick it to start clean.
5. Turn its switch on.
6. Click its row in the sidebar. Plisto shows a short "Starting" card until the page answers its first
   heartbeat, then your page.

If Plisto refuses the folder, the message says why. The [manifest reference](manifest.md) lists the
causes.

A native plugin installs the same way. Its review sheet is heavier, and its program starts when you turn
it on. See the [native guide](native.md), and [`examples/tap-meter`](../examples/tap-meter/README.md) for
packing, installing and where its logs are.

## Install from a file

A `.plistoplugin` file is a zip archive of your plugin folder. Make it with the script in
[Pack your plugin](#pack-your-plugin). `plugin.json` may be at the root of the archive or inside one
top-level folder. Use Install from file in Settings > Plugins, or drop the file into the plugins folder that
the Open plugins folder button opens and press Review on its entry. Use plain zip compression (stored or
deflate); encrypted archives are refused.

## Pack your plugin

`examples/pack.ps1` builds the installable `.plistoplugin` file. It needs only Windows PowerShell and writes
`<id>-<version>.plistoplugin`, a zip with `plugin.json` at its root.

```
powershell -File examples\pack.ps1 -Path C:\work\my-plugin
powershell -File examples\pack.ps1 -Path C:\work\my-plugin -Out C:\work\release
powershell -File examples\pack.ps1                    # the samples hello-ui and hello-background
powershell -File examples\pack.ps1 -Sample hello-ui   # one sample, by name
```

- **`-Path <folder>`** packs any plugin folder, such as your own. Every file in it goes into the archive,
  except dotfiles, dot folders and `.plistoplugin` files. The archive is written beside the folder (in its
  parent folder) unless you give `-Out <folder>`; it refuses to write inside the folder it packs. Before it
  packs, the script reads `plugin.json`, refuses a `name` or `author` with a space at either end, and checks that the `entry`, the `page` and the `icon` it names exist
  in the folder, and prints a warning when your `plisto-sdk.js` is not the kit's current file.
- **`-Sample <name>`** (and no parameter at all) packs a sample from the kit. The file goes to the sample's
  `dist` folder unless you give `-Out`. A sample is packed without its README, and the script refuses when its
  `plisto-sdk.js` is not byte-identical to `sdk/plisto-sdk.js`; copy the kit's file over it and run again.

The script prints each entry it wrote. Pack the folder you would install: it holds only what runs, so keep
sources, tests and build output (a `target` or `node_modules` folder) out of it.

**The entry-name rule.** Plisto refuses an archive whose entry names have a backslash, an absolute path, a
drive letter or a `..` part, and names that differ only in case. `Compress-Archive` in Windows PowerShell 5.1
writes `sub\file.txt` for a file in a subfolder, so an archive made with it is refused as soon as the plugin
has a folder. The script builds the archive entry by entry with `System.IO.Compression.ZipArchive` and writes
each name with forward slashes, so use it, or list the entries of an archive from another tool and look for
`\`. `plugin.json` must be at
the root of the archive, or inside exactly one top-level folder that holds everything.

**Shipping a native plugin.** The archive is the same folder Plisto installs, so it must hold, at the paths
`plugin.json` names:

- `plugin.json`, at the root;
- the program, at the `entry` path (for example `bin/tap-meter.exe`), and any DLL or data file it loads
  beside it, since Plisto starts it with the plugin's folder as its working directory;
- the page folder, when `page` is set, with its own copy of `plisto-sdk.js`;
- the `icon`, when set.

It must stay inside 4,096 files and 256 MiB. Do not ship files the program writes: it keeps its own state in
the data folder Plisto passes it, which survives updates (see [native](native.md#how-plisto-launches-the-process)).
The tap-meter sample has a `pack.ps1` that builds the Rust program in release mode, lays out the folder
`dist\dev.plisto.tapmeter` and then calls `examples\pack.ps1 -Path` on it, so one command ends in
`dist\dev.plisto.tapmeter-<version>.plistoplugin`. For a program built another way, do those two steps
yourself: lay out the folder, then run `pack.ps1 -Path` on it. Test the final `.exe` on a machine with a
default Windows Defender: see [when antivirus blocks the program](lifecycle.md#when-antivirus-blocks-the-program).

Before you install, you can try the page in a browser with the [mock host](getting-started.md#develop-in-a-browser-with-the-mock-host).

## Update while developing

1. Change your files.
2. Raise `version` in `plugin.json`.
3. Install the folder again, as above. Plisto sees the same `id` and shows an update sheet.
4. A UI plugin whose review sheet is unchanged stays on and its page restarts on the new version. The sheet
   is the `capabilities`, the `network` origins, `native_reason` and the `author`. If you added or removed a
   capability or an origin, reworded `native_reason` or changed `author`, the plugin turns off and asks for
   approval: use Review, then approve it. A native plugin always turns off and asks again, on every update.
   The rule is in [lifecycle](lifecycle.md#updates-and-the-manifest-hash).

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

- If the review sheet changed (`capabilities`, the `network` origins, the native reason or the `author`),
  the plugin turns off and Plisto opens the review, as for an update. A native plugin does this on every
  reload. Approve it to turn the plugin back on.
- Reload from source and the log panel work only while developer mode is on. With it off, Plisto refuses
  both, and the row has neither button.
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
to remove its storage. With the box ticked Plisto removes the whole `plugins-data\<id>\` folder, so a native
program's own files, its logs and its web view profile go with it.

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
| The page shows a crash card | It was silent for 15 seconds, or it loaded a new document (a reload or a `location` change; a form post is blocked by the sandbox). |
| Styles are missing | The two `/_plisto/` sheets must be linked with absolute paths, as shown in [getting started](getting-started.md). |
| A file the page names does not load, with no message | Plisto serves only 16 extensions (`html js css json txt png jpg jpeg gif webp svg ico woff woff2 ttf otf`) and refuses the rest, so `.wasm`, `.mp3`, `.mjs`, `.map` and `.avif` all fail. A path with a space or over 128 characters fails too. Rename data files to `.txt` or `.json`. See [UI surfaces](ui-surfaces.md#files-plisto-serves). |
| `fetch`, a WebSocket, a worker, an `<audio>` or `<iframe>` does nothing | The frame's content security policy has no network, media, worker or frame source, and the sandbox is `allow-scripts` only. Use `plisto.net` and [streams](stream.md). See [the policy](ui-surfaces.md#the-content-security-policy). |
| A font does not load | Fonts load from your own folder as `.woff`, `.woff2`, `.ttf` or `.otf` only. A remote font cannot load. Without a bundled font, use `var(--font-ui)`. |
| The page never starts and no background plugin runs, though the plugin is on | The library has no tracks, or no folder has been added. Plisto starts page frames only once the library has tracks (a native program still starts). Add a folder. |
| A native plugin row says "Could not start: Windows would not let it launch" | An antivirus or a policy blocked the program. See [lifecycle](lifecycle.md#when-antivirus-blocks-the-program). |
| The plugin turned off after an update | The update changed what the user approved (a capability, an origin, the native reason or the author), or the plugin is native: a native update always asks again. See [lifecycle](lifecycle.md#updates-and-the-manifest-hash). |
| Install says the archive is not valid | An entry name has a backslash, or `plugin.json` is not at the root or in one top-level folder. Pack with `examples\pack.ps1`. |
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
- [ ] Every file the page loads is in the folder and has one of the 16 extensions Plisto serves. No external
      addresses, no inline script.
- [ ] A native plugin's archive holds the program at the `entry` path, and you started the final `.exe`
      under a default Windows Defender.
- [ ] You tested a first run, a second run, an update from your previous version, and an uninstall.
- [ ] You tested light and dark, and both languages if your page shows text from `info.locale`.
- [ ] The page never blocks the main thread. A background plugin has been left running for some time.
- [ ] Logs hold no secrets or personal data.
- [ ] You installed the final folder, or the final `.plistoplugin` file, from scratch in Plisto.

Then pack the folder with [`examples\pack.ps1 -Path`](#pack-your-plugin) and share the `.plistoplugin` file.
Tell users that Plisto asks them to approve its capabilities when they install it.
