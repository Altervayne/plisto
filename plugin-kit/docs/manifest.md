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
| `name` | yes | 1 to 40 characters. |
| `version` | yes | Semantic version, for example `1.2.3`. |
| `tier` | yes | `"ui"` for everything in this kit. |
| `entry` | yes | Relative path to an `.html` file in the folder. |
| `capabilities` | yes | List of capability names. May be empty. No duplicates. |
| `min_plisto` | yes | Semantic version of the oldest Plisto that runs the plugin. |
| `author` | yes | 1 to 80 characters. |
| `homepage` | no | An `https` address, at most 200 characters. |
| `icon` | no | Relative path to a `.png` or `.svg` file. |
| `modes` | no | List of `"player"` and `"organizer"`. |
| `sidebar` | no | The sidebar block. Needs the `ui.sidebar` capability. |

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
no run of more than 6 combining marks. Plisto
shows them as written on the review sheet, in the plugin list and in the sidebar. The author is shown as
declared by the plugin and not verified.

### `version` and `min_plisto`

Semantic versions: `major.minor.patch`, with an optional `-prerelease` part and an optional `+build` part
(the build part is ignored). At most 32 characters. No leading zeros, no `v` prefix, no two-part forms
like `1.0`.

If `min_plisto` is newer than the running Plisto, the manifest is valid but the plugin cannot be installed
or turned on. The user sees "needs Plisto X or newer". Set `min_plisto` to the oldest version that has the
methods you use. The plugin system and the UI surfaces (toast, confirm, chips, sidebar items) first ship in
Plisto 2.7, so `"2.7.0"` is the right value for a plugin that uses any of them.

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
`-` and `/`. No empty, `.` or `..` part, no trailing dot, no drive letter, no Windows device name.

## Capabilities

A capability is a permission. The user sees the list on the review sheet, in plain language, before the
plugin runs. Plisto grants all of them or none: there is no partial grant.

| Capability | What it gives | Used by |
| --- | --- | --- |
| `storage` | The plugin's saved data. | `storage.*` methods |
| `background` | Keep the page running while another page is shown. | [lifecycle](lifecycle.md) |
| `ui.toast` | Show short toasts. | `ui.toast` |
| `ui.confirm` | Ask the user to confirm something. | `ui.confirm` |
| `ui.chips` | Put chips on the plugin's sidebar row. | `ui.chips` |
| `ui.sidebar` | Declare sidebar entries and update them live. | `sidebar` block, `ui.sidebar.update` |

`app.info`, `app.methods`, `log.write` and `ui.open_page` need no capability.

The manifest also accepts the names `library.read`, `playback.read`, `playback.control` and `network`. No
API method needs the first three yet, so asking for them gives your page nothing. `network` requires a
`network` list of `https://host` origins in the manifest, but the page's security policy still blocks
every request, so do not build on it. The audio capabilities are for native plugins only and a UI plugin
that lists one is refused. Ask only for what you use: a smaller list is easier for a user to approve.

Two further rules:

- `background` is for UI plugins only.
- A `sidebar` block needs `ui.sidebar`. Live items (anything but `nav`) also need `background`. See the
  [sidebar guide](sidebar.md).

## Why a manifest is refused

Plisto checks the manifest when you install, and again every time it starts. Each refusal is one line.

| Message starts with | Cause |
| --- | --- |
| `plugin.json is N bytes, over the 65536 byte limit` | File too large. |
| `plugin.json is not valid` | Not JSON, wrong field type, or a duplicated key. |
| `missing required field` | One of the required fields is absent. |
| `unsupported manifest_version` | Not `1`. |
| `invalid id` | The id breaks the rules above. |
| `'name' must not be empty`, `is over N characters`, `contains control characters`, `has more than 6 combining marks in a row` | Text rule broken. |
| `'version' is not a valid version` | Not semantic version. Same for `min_plisto`. |
| `unknown tier` | Not `ui`. |
| `'entry' ...` | A path rule broken. |
| `a ui plugin's entry must be a .html file` | Wrong extension. |
| `'icon' must be a .png or .svg file` | Wrong extension. |
| `unknown capability`, `capability ... is listed twice` | Check the spelling. Names are lowercase. |
| `capability ... is not available to ui plugins` | An audio capability. |
| `unknown mode`, `mode ... is listed twice`, `'modes' must list at least one mode` | See `modes`. |
| `'homepage' ...` | Not a valid `https` address. |
| `sidebar must have 1 to 6 items` and other `sidebar` lines | See the [sidebar guide](sidebar.md). |

Plisto also checks files when it installs or starts: the entry file and the icon must exist and be plain
files inside the plugin folder, and the manifest `id` must match the folder it was installed under. A
manifest that passes the checks but names a missing file shows "the file named by 'entry' is missing".
