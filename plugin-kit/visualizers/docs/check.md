# Check your visualizer

`check-visualizer.mjs` runs a plugin folder through what Plisto will do with it, before you pack it. It needs
Node and Microsoft Edge on Windows. It starts a server on 127.0.0.1 only, opens Edge without a window, and
closes both when it ends. It makes no other network request and downloads nothing.
The installer checks the plugin's id, name, version, icon and sidebar; this command does not.

```powershell
node plugin-kit/visualizers/check-visualizer.mjs .\my-visualizer
node plugin-kit/visualizers/check-visualizer.mjs .\my-visualizer --kind aurora-rings --seconds 20 --json
```

| Option | Meaning |
| --- | --- |
| `--kind K` | Check one kind of the plugin. The default is every kind it declares |
| `--seconds S` | How long the scripted run plays after the first frame. Default 10 |
| `--json` | Print the whole report as JSON instead of lines |
| `--out DIR` | Where the stills are saved. The default is a new `plisto-kit-check-stills-*` folder under the temp folder, named in the report |
| `--soft` | Draw with software GL instead of the GPU. Slow; its timings do not say much |
| `--edge PATH` | The Edge executable, when it is not in a standard place |

## What it checks

For each kind it reports five things.

1. **Manifest.** The `visualizers` block, the capabilities it needs and the files it names, by the same rules
   and with the same refusal wording as Plisto's installer. A refusal stops the check: nothing else runs.
   Other manifest fields (id, name, version, icon, sidebar) are checked by Plisto at install.
2. **Compile.** The kind is mounted the way the Player mounts it: in a sandboxed frame with the runtime,
   sent `plisto:vis-init` over a message channel, with the flash meter on. The result is `ready`, with how
   long the first frame took, or the runtime's `error` with its stage (`compile`, `setup`, `draw` or `still`)
   and message. A kind that draws no frame within 20 seconds fails with the stage `ready`.
3. **Scripted run.** A synthetic feed plays for `--seconds`: one tick per display frame, a beat every half
   second, bands sweeping across the spectrum, a breathing level, one surge and one cut. It is not music, so
   a kind that only moves on a real recording shows less than it will. The run is judged by Plisto's limits.
4. **Still.** The picture the kind gives under reduced motion, from a mount that is never ticked, saved as
   `<kind id>.png`. A raw kind with no canvas and no `still` handler has none; the report says so.
5. **Listing.** Whether the plugin appears only in Settings, Visualizers, or in the Plugins list as well, and
   what put it there. See [Where your plugin is listed](../README.md#where-your-plugin-is-listed).

## The limits

| Finding | Rule | Counts as |
| --- | --- | --- |
| Flashing | More than 3 flashes a second over a quarter of a one-third-stage window, or any saturated red flash. See [photosensitivity](photosensitivity.md) | A warning |
| Slow | The median step cost stays over 50 ms across 5 seconds | A failure |
| Hang | No frame within 2000 ms after the first frame, or a gap that long later | A failure |

The meter reports only when it trips, so a kind that stays under the limit has no reading: the report says
"never over the limit" and prints no figures. A raw kind with no registered canvas is "not judged for
flashing", and the report says so: Plisto cannot watch it either.

Flashing is a warning you must read. Plisto stops a flashing plugin visualizer only when the user turns on
"Stop plugin visualizers that flash", so the check does not call it a refusal. The exit code still tells it
apart, so a CI step can choose what to do with it.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Everything passed |
| 1 | The manifest is refused, or a kind failed to compile, is slow or hung |
| 2 | The command could not run: a bad option, no Edge, or the browser failed |
| 3 | Only flashing was found |

`plugin-kit/examples/pack.ps1` runs the check on a folder before packing it when Node is on the path, and
skips it with a note when it is not.
