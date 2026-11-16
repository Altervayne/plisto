# Manifest reference

This page lists every field of `plugin.json`, the limits on each and the reasons Plisto refuses a
manifest. For a first example see [getting started](getting-started.md); for the sidebar block see the
[sidebar guide](sidebar.md).

## Rules for the file

- The file is named `plugin.json` and sits at the root of the plugin folder.
- It is JSON, at most 64 KiB. A UTF-8 byte order mark is accepted.
- A duplicated key makes the file invalid.
- Unknown fields are ignored. An unknown capability or mode makes the manifest invalid.
- Any change to `plugin.json` after the user approved the plugin returns it to "needs review" (see
  [lifecycle](lifecycle.md)).

## Example

```json
{
  "manifest_version": 1,
  "id": "com.example.my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "tier": "ui",
  "entry": "index.html",
  "capabilities": ["storage", "ui.toast"],
  "min_plisto": "2.7.0",
  "author": "Your Name",
  "homepage": "https://example.com/my-plugin",
  "icon": "icon.svg",
  "modes": ["player", "organizer"]
}
```

## Fields

| Field | Required | Rule |
| --- | --- | --- |
| `manifest_version` | yes | The number `1`. |
| `id` | yes | See below. |
| `name` | yes | 1 to 40 characters, with no space at the start or end. |
| `version` | yes | Semantic version, for example `1.2.3`. |
| `tier` | yes | `"ui"`, or `"native"` for a program Plisto starts (see the [native guide](native.md)). |
| `entry` | yes | Relative path to an `.html` file in the folder; for a native plugin, to an `.exe` file. |
| `page` | native only | Relative path to an `.html` file in the folder: the native plugin's page. Same path rules as `entry`; the name must end in `.html` (any case) and the file must exist. A native plugin with a sidebar `nav` item must give it. A UI plugin that sets it is refused: its page is its `entry`. |
| `native_reason` | native only | 1 to 280 characters, shown on the review sheet. Required for a native plugin. |
| `capabilities` | yes | List of capability names. May be empty. No duplicates. |
| `min_plisto` | yes | Semantic version of the oldest Plisto that runs the plugin. |
| `author` | yes | 1 to 80 characters, with no space at the start or end. |
| `homepage` | no | An `https` address, at most 200 characters. |
| `icon` | no | Relative path to a `.png` or `.svg` file. |
| `modes` | no | List of `"player"` and `"organizer"`. |
| `sidebar` | no | The sidebar block. Needs the `ui.sidebar` capability. |
| `network` | with `network` | List of `https://host` origins, or `http://127.0.0.1:<port>` and `http://localhost:<port>` for development. At most 8. Present exactly when the `network` capability is declared. See the [network guide](network.md). |

### `id`

- 3 to 64 characters of `a-z`, `0-9`, `.` and `-`. Lowercase only.
- At least two parts separated by dots, for example `com.example.my-plugin`.
- No empty part, and no part that starts or ends with `-`.
- No part may be a Windows device name (`con`, `nul`, `com1` and so on).
- It must not end in `.new` or `.old`.

The id is the plugin's identity. It names the plugin's folder, its saved data and its log. An update must
carry the same id as the installed plugin.

### `name`, `author`

Plain text, not blank, with no control characters and no invisible or text-direction characters, and
no run of more than 6 combining marks. Neither may start or end with a space (any Unicode whitespace):
trim them. Plisto
shows them as written on the review sheet, in the plugin list and in the sidebar. The author is shown as
declared by the plugin and not verified.

### `version` and `min_plisto`

Semantic versions: `major.minor.patch`, with an optional `-prerelease` part and an optional `+build` part
(the build part is ignored). At most 32 characters. No leading zeros, no `v` prefix, no two-part forms
like `1.0`.

If `min_plisto` is newer than the running Plisto, the manifest is valid but the plugin cannot be installed
or turned on. The user sees "needs Plisto X or newer". Set `min_plisto` to the lowest Plisto version you tested the plugin on, and no lower: Plisto checks only
this number, not the methods you call. The plugin system and the UI surfaces (toast, confirm, chips, sidebar
items) first ship in Plisto 2.7, so `"2.7.0"` is the right value for a plugin that uses any of them, and the
event and stream methods (`events.subscribe`, `stream.*`) need 2.7.0 or newer too.

While you develop against a pre-release build that still reports 2.6.x, use `"2.6.0"`: Plisto refuses to
turn on a plugin whose `min_plisto` is newer than the build. Set `"2.7.0"` before you release.

### `entry`

The page Plisto opens. It must be an `.html` file (the extension check ignores case) and a plain file in
the folder.

### `icon`

A `.png` or `.svg` file in the folder, at most 256 KiB, and square. A PNG must be at least 64 by 64
pixels. An SVG is square when its `viewBox` or its `width` and `height` are equal. Plisto shows the icon
on the plugin's row. An invalid icon makes the whole plugin invalid. The sidebar draws the plugin's own
glyph from a fixed icon list instead (see the [sidebar guide](sidebar.md)).

### `homepage`

`https://` and a host, at most 200 characters, visible ASCII only, none of `"` `'` `<` `>` `\` and the
backtick.

### `modes`

Which app modes show the plugin in the sidebar: a list containing `"player"`, `"organizer"` or both.
Plisto has a Player mode, an Organizer mode and a mode that shows both. A plugin that lists a mode is
shown in that mode, and in the mode that shows both. Leave `modes` out and the plugin shows in Player mode
only. An empty list, an unknown mode or a repeated mode makes the manifest invalid.

A plugin that is hidden in the current mode has no sidebar row, no page and no finder entry. Its
background page, if it has one, keeps running.

### Paths

Every path in the manifest (`entry`, `icon`, and files you link from your page) follows the same rules:
forward slashes only, relative, at most 128 characters in the manifest, made of letters, digits, `.`, `_`,
`-` and `/`. No empty, `.` or `..` part, no part ending in a dot, no drive letter, no Windows device name.
The same rule decides which files Plisto serves to your page, and Plisto serves only 16 file extensions: see
[UI surfaces](ui-surfaces.md#files-plisto-serves).

## Capabilities

A capability is a permission. The user sees the list on the review sheet, in plain language, before the
plugin runs. Plisto grants all of them or none: there is no partial grant.

The third column is the line the user reads on the review sheet, word for word, in English. Plisto
translates it for a French user, and the sheet draws it from its own text, never from yours.

| Capability | What it gives | Shown to the user as | Used by |
| --- | --- | --- | --- |
| `storage` | The plugin's saved data. | Save its own settings and data | `storage.*` methods |
| `background` | Keep the page running while another page is shown. | Runs in the background while Plisto is open | [lifecycle](lifecycle.md) |
| `ui.toast` | Show short toasts. | Show short messages | `ui.toast` |
| `ui.confirm` | Ask the user to confirm something. | Ask you to confirm things | `ui.confirm` |
| `ui.chips` | Put chips on the plugin's sidebar row. | Show a badge on its sidebar entry | `ui.chips` |
| `ui.sidebar` | Declare sidebar entries and update them live. | Add entries to the sidebar | `sidebar` block, `ui.sidebar.update` |
| `network` | Exchange data with the sites in the `network` list, through Plisto. | Exchange data with the sites listed below, then each origin, then the notes below | `plisto.net`, see the [network guide](network.md) |
| `library.read` | Read the library: titles, artists, albums, playlists and covers, never file locations. | Read your library (titles, artists, albums; never file locations) | `library.*` methods, see the [API reference](api.md#library-data); the `library_changed` event |
| `playback.read` | Read what is playing and the queue. | Read what is playing | `playback.state`, `playback.queue`; the `now_playing`, `playback_state` and `queue` events |
| `playback.control` | Play, pause, skip, seek and change the queue. The `queue.*` methods also need `library.read`: without both they are `denied`. | Play, pause and skip tracks | the other `playback.*` methods, `queue.*` (with `library.read`) |
| `playback.stream` | Play audio streams through Plisto's player, a URL it fetches or bytes the plugin pushes. | Play audio streams through Plisto's player at any time, pausing your music, with their own titles on your media keys and lock screen | `stream.*` methods, see the [stream guide](stream.md) |
| `audio.tap` | Read Plisto's audio. Native plugins only. | Hear Plisto's audio after the equalizer | the [native guide](native.md#the-audio-tap) |
| `audio.events` | Follow playback as `feed` events. Native plugins only. | Follow changes in your sound devices and playback | the [native guide](native.md#the-feed) |
| `audio.device` | Name the output device in `feed` events. Native plugins only. Needs `audio.events`. | Use your sound devices | the [native guide](native.md#the-feed) |
| `audio.output_takeover` | Hold Plisto's own output silent. Native plugins only. | Silence Plisto's own speakers while it plays your music | the [native guide](native.md#output-takeover) |

The sheet adds notes of its own beside some lines. Under `network` it lists each origin (a development
address is tagged "This computer, only while developer mode is on") and says: "Plisto makes these
connections for it and refuses every other address. The sites see your internet address, as when you
visit them." With `playback.stream` too: "It can play audio from the sites listed above." For a UI plugin
that also holds `library.read` or `playback.read`: "It can send what it reads here, such as your library or
what is playing, to these sites." A capability this Plisto has no line for is not drawn, and is still
granted. After an update, a line or an origin that the approved version lacked carries a "New" badge.

What else the sheet says, by kind of plugin:

| Plugin | Warning on the sheet |
| --- | --- |
| UI plugin | "It runs in a sandbox inside Plisto. It cannot read your files, and it can only reach the sites listed above." Without `network`: "It runs in a sandbox inside Plisto. It cannot read your files or reach the network." |
| UI plugin while Plisto's sandbox check has not passed (the Unsandboxed tag) | "This plugin runs inside Plisto and Plisto cannot yet fully contain it. Until it can, the plugin may be able to read your library and files and use the network beyond what it lists. Plisto does not review or vouch for it." |
| Native plugin | "This plugin is a program that runs on your computer with your access. It can read and change your files and use the network. Plisto does not review or vouch for it." Then "Why it is native (declared by the plugin)" and your `native_reason`, as plain text. |

On the two warning sheets the user also ticks "I understand" before a confirm that turns the plugin on. Every
sheet shows the author as "By <author>. Declared by the plugin, not verified."

`app.info`, `app.methods`, `log.write` and `ui.open_page` need no capability, and neither do the `theme`,
`locale` and `app_mode` events of the [events guide](events.md).

`network` requires a `network` list of origins in the manifest, and the page can then reach only those
sites, through `plisto.net`. The [network guide](network.md) covers the origin rules and the developer
loopback origins. The audio capabilities are for native plugins only and a UI plugin that lists one is
refused. Ask only for what you use: a smaller list is easier for a user to approve.

`playback.stream` is for both tiers. The user reads this line on the review sheet: "Play audio streams through
Plisto's player at any time, pausing your music, with their own titles on your media keys and lock screen".
It is the only consent a stream needs: a plugin that holds it can start one with no click and no open
page. A stream from a URL also needs `network` and the site in the `network` list; with both declared the
sheet adds "It can play audio from the sites listed above." A plugin that only pushes bytes needs no
`network`. The [stream guide](stream.md) says what a start does to the user's music.

Two further rules:

- `background` is for UI plugins only: a native plugin that lists it is refused.
- A `sidebar` block needs `ui.sidebar`. Live items (anything but `nav`) depend on the tier. A UI plugin
  needs `background` for them, since a running page is what keeps them live. A native plugin needs no
  `background`: its program handles them. See the [sidebar guide](sidebar.md).

## Why a manifest is refused

Plisto checks the manifest when you install, and again every time it starts. Each refusal is one line.

| Message starts with | Cause |
| --- | --- |
| `plugin.json is N bytes, over the 65536 byte limit` | File too large. |
| `plugin.json is not valid: ...` | Not JSON, a field of the wrong type, or a duplicated key. The rest of the line says which. |
| `missing required field 'x'` | One of the required fields is absent. `native_reason` has its own line below. |
| `unsupported manifest_version N` | Not `1`. |
| `invalid id: ...` | The id breaks the [rules above](#id). The rest of the line says which. |
| `'name' must not be empty`, `'name' is over N characters`, `'name' contains control characters`, `'name' has more than 6 combining marks in a row` | A text rule broken. The same lines name `author` and `native_reason`. |
| `'name' must not start or end with a space` | `name` or `author` (the line names the field) has a space at the start or end. |
| `'version' is not a valid version: 'x'` | Not a semantic version. Same for `min_plisto`. |
| `unknown tier 'x'` | Not `ui` or `native`. |
| `'entry' ...`, `'page' ...`, `'icon' ...` followed by `must not be empty`, `is too long`, `must be relative`, `must use '/' separators`, `may only contain letters, digits, '.', '_', '-' and '/'`, `must not contain an empty segment`, `must not contain '.' or '..' segments`, `a segment must not end with '.'` or `a segment is a reserved Windows device name` | A path rule broken (see "Paths"). |
| `a ui plugin's entry must be a .html file` | The `entry` of a UI plugin has another extension. |
| `a native plugin's entry must be a .exe file` | The `entry` of a native plugin has another extension. |
| `'page' is only for native plugins (a UI plugin's page is its 'entry')` | A UI plugin sets `page`. Remove it. |
| `'page' must be a .html file` | A native plugin's `page` has another extension. |
| `'icon' must be a .png or .svg file` | Wrong extension. |
| `a native plugin must give 'native_reason'` | A native plugin has no `native_reason`. It also needs 1 to 280 characters (the text lines above). A UI plugin's `native_reason` is ignored, not refused. |
| `a native plugin with a sidebar 'nav' item must give 'page', the page the item opens` | A native plugin declares a nav item and has no `page`. |
| `unknown capability 'x'`, `capability 'x' is listed twice` | Check the spelling. Names are lowercase. |
| `capability 'x' is not available to ui plugins` | An audio capability in a UI plugin. |
| `capability 'x' is not available to native plugins` | `background` in a native plugin. |
| `the 'audio.device' capability requires 'audio.events', the only place the device is reported` | List `audio.events` too. |
| `unknown mode 'x'`, `mode 'x' is listed twice`, `'modes' must list at least one mode` | See `modes`. |
| `'homepage' ...` followed by `is too long`, `must be an https URL`, `must name a host` or `contains characters that are not allowed in a URL` | Not a valid `https` address. |
| `the 'network' capability requires a non-empty 'network' origin list` | `network` is listed and the origin list is missing or empty. |
| `'network' origins are only allowed with the 'network' capability` | An origin list without the capability. Add the capability or remove the list. |
| `'network' lists N origins, over the limit of 8` | More than 8 origins. |
| `network origin 'x' ...` followed by `is too long` (over 128 characters), `must start with https://`, `must not use wildcards`, `must not carry credentials`, `must be a bare origin without a path, query or fragment`, `has an invalid port`, `must be a lowercase DNS host name`, `must not be an IP address`, `uses a reserved name that is not on the public internet` or `is not a development address Plisto accepts (use http://127.0.0.1:<port>)` | A bad origin. See the origin rules in the [network guide](network.md#origins). |
| `network origin 'x' is listed twice` | The same origin twice. |
| `sidebar block requires the 'ui.sidebar' capability` and the other `sidebar` lines below | See the sidebar table. |

The `sidebar` lines, from the same check:

| Message | Cause |
| --- | --- |
| `sidebar must have 1 to 6 items, found N` | No items, or more than 6. |
| `unknown sidebar layout 'x'` | `layout` is not `compact` or `section`. |
| `sidebar item N is missing 'id'` (or `type`, `label`) | A required item field is absent. `N` counts from 1. |
| `sidebar item id 'x' must be 1 to 32 characters of a-z, 0-9 and '-'` | A bad item id. |
| `duplicate sidebar item id 'x'` | Two items share an id. |
| `sidebar item 'x' has an empty label`, `label is over 24 characters`, `label has control characters`, `label has more than 6 combining marks in a row` | A label rule broken. |
| `sidebar item 'x' has unknown type 'y'` | Not `nav`, `status`, `progress`, `toggle` or `action`. |
| `sidebar item 'x' has unknown icon 'y'` | Not in the [icon list](sidebar.md#icon-names). |
| `sidebar item 'x' route ...` followed by `must not be empty`, `is too long` or `may only contain visible ASCII characters` | A bad `route` (1 to 64 visible ASCII characters). |
| `sidebar item 'x': 'route' is only allowed on nav items` (or `'icon'`) | `route` or `icon` on another type. |
| `sidebar item 'x' is live and requires the 'background' capability` | A UI plugin has a `status`, `progress`, `toggle` or `action` item without `background`. |

Plisto also checks files when it installs or starts: the entry file and the icon must exist and be plain
files inside the plugin folder, and the manifest `id` must match the folder it was installed under. A
manifest that passes the checks but names a missing file shows "the file named by 'entry' is missing".
