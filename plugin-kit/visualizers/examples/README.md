# Examples

Four finished visualizer plugins. Each is a plugin folder with a `plugin.json`.

| Folder | Form | What it shows |
| --- | --- | --- |
| `level-glow/` | `shader` | A shader kind with a color setting, a range setting and a preset. Brightness follows only the eased level, so it cannot flash |
| `band-tunnel/` | `scene` | A scene kind with script state. The spectrum bends the rings, the bass swell sets the speed, a choice setting scales it, and a paused track holds still. The plugin has no page of its own, so it is listed in Visualizers |
| `lake/` | `candidate` | One of Plisto's own kinds as a plugin, written with the kit as the built-in kinds are. It uses the cover and fills the whole stage |
| `three-orbs/` | `raw` | A raw kind drawn with three.js on its own WebGL canvas. Three lit orbs circle the centre; the level and bands set their size and glow, the bass swell sets the speed, and a paused track holds still |

All four declare only `visualizer`, so Plisto lists each in Settings, Visualizers. Pack one with
`plugin-kit/examples/pack.ps1 -Path <folder>`.

`three-orbs/vis/vendor/` holds three.js 0.160.0 under its MIT license, unmodified.

`lake/vis/lake.js` is a generated copy of [`../fixtures/lake.js`](../fixtures/lake.js); edit neither.
