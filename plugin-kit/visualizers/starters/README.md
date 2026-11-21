# Starters

One minimal plugin per form. Each is a complete plugin folder with a `plugin.json`: copy it, change the
plugin `id`, `name` and `author`, and edit the files under `vis/`.

| Folder | Form | What it draws |
| --- | --- | --- |
| `shader/` | `shader` | A disc of light around the cover that grows with the level |
| `scene/` | `scene` | Six spokes under a ring, turning with the bass swell |
| `candidate/` | `candidate` | One bar per band along the bottom of the stage |
| `raw/` | `raw` | The same bars on a 2D canvas, with the canvas returned so Plisto can take the still and watch it |

The plugin ids here are `com.example.*`. Use your own reverse-DNS id for a plugin you share. Pack a folder
with `plugin-kit/examples/pack.ps1 -Path <folder>`, or install it with From folder... in Settings, Visualizers.

See the [visualizer guide](../README.md) for the forms and the manifest block.
