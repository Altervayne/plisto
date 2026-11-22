# Visualizers

A visualizer plugin adds kinds to Plisto's Player visualizer catalog. A kind draws a full stage of moving
picture from the music: from the audio levels and spectrum, the cover's colors and the track. This guide
covers what a visualizer plugin is, the four ways to write one, the manifest block, where the plugin shows
up in Plisto, the flash meter and what the user is told at install.

Read the general [plugin guides](../README.md) first for what a plugin is, how to pack one and how
installing works. This page only covers what is different for visualizers.

## What you write

A visualizer plugin is a folder with a `plugin.json` and the files its kinds name: a fragment shader, or an
HTML page with a script. It can have no page of its own. Plisto runs each kind in a sandboxed frame and
feeds it the music on every display frame.

The frame loads Plisto's visualizer runtime, a script that Plisto serves to every kind. It sets one global,
`plistoVis`, and does the compiling, the drawing, the stills and the flash meter for you. You do not copy
it.
A page includes it like this:

```html
<script src="/_plisto/vis/1/plisto-vis.js"></script>
<script src="mykind.js"></script>
```

The kit's starters and examples are classic scripts, and that is what the kit tests. Inline scripts are
blocked. To use a library, bundle it into one script. The frame has no network and no keyboard: Plisto keeps
V, Space and the global shortcuts. A frame can run blob workers and WebAssembly.

## Start from a starter

[`starters/`](starters) holds one minimal working plugin per form. Copy one, change the ids in
`plugin.json`, and pack the folder:

```powershell
powershell -File plugin-kit/examples/pack.ps1 -Path .\my-visualizer
```

Install the `.plistoplugin` file from Settings, Visualizers, Add visualizers, From file... Developers can use
From folder... to install without packing. [`examples/`](examples) holds three finished plugins to read:
Level glow, Band tunnel and Lake.

## Check your visualizer

Run `node plugin-kit/visualizers/check-visualizer.mjs <plugin-folder>`. It reads the manifest by Plisto's own
rules, mounts each kind in Edge through the real runtime, plays a scripted feed against the flashing,
slow-frame and hang limits, saves a still and says where the plugin will be listed. It exits 0 when all
passes, 1 on a failure and 3 when the only finding is flashing. See [docs/check.md](docs/check.md).
To watch it live while you work, run `node plugin-kit/sdk/mock-serve.mjs 8765 <plugin-folder> --watch`
and open the harness it prints. See [docs/harness.md](docs/harness.md).

## The four forms

Pick the form by how much of the work you want Plisto to do.

| Form | You write | Plisto gives you | Pick it when |
| --- | --- | --- | --- |
| `shader` | One `.frag` file | The prelude, `uPrev` (the previous frame), the settings as uniforms | You want a visualizer in an hour |
| `scene` | A script: one or more fragment passes, state, per-frame `update` | Named buffers, feedback, additive passes, trails, beat rings, the same prelude | You need state or several passes |
| `candidate` | A factory over the `Kit` | The same `Kit` Plisto's own kinds are written with | You want everything a built-in has |
| `raw` | Handlers, on any canvas, DOM or SVG | The feed and a stage | You use a library or 2D canvas |

All four take the same [feed](docs/feed.md) and the same composite, which is how Plisto maps the picture
onto the stage for the theme. A plugin with a page can also use the [channel](docs/channel.md).

### shader

The manifest names a `.frag` or `.glsl` file with `shader`; there is no page. Plisto compiles your file
after a prelude and calls `main()` for every pixel. Write only `main()` and write the pixel to `outColor`.
Do not write `#version`: the prelude opens with it. The first line of your file is line 1 in compile errors.

The prelude declares these uniforms:

| Uniform | Meaning |
| --- | --- |
| `uRes`, `uDpr` | The stage size in device pixels, and the pixel ratio |
| `uTime` | Seconds |
| `uBands[24]`, `uFine[128]` | The 24 smoothed bands; the smoothed 128-band spectrum when the kind needs `fine` |
| `uLevel`, `uRms` | The eased level, 0..1. Both carry the same value; use it for brightness |
| `uPeak`, `uFlux`, `uKick` | The peak, the onset flux and the beat pulse. Fast: motion only |
| `uBass`, `uMid`, `uHigh` | The three band group levels |
| `uSwell`, `uBassM`, `uMidM`, `uHighM` | The slow bass swell and the three motion envelopes |
| `uFlow` | A running phase: time that advances at 0.25 plus the level per second, for motion that should not stall or jump |
| `uPal[3]` | The cover palette, three colors |
| `uCover`, `uRadius`, `uCoverTex` | The cover rect (left, bottom, width, height, in device pixels), its radius, and its pixels when the kind needs `cover` |
| `uAmbient`, `uLight`, `uGround`, `uFloor` | Ambient mode, the theme, the stage ground and the top edge of the element the layer rests on |
| `uRings[3]` | The live beat rings, as age and height per ring |
| `uHush[2]`, `uHushFeather` | The text blocks to quiet behind, and the feather width |
| `uPrev` | The previous frame of your own output |
| `uSetting_<id>` | One per declared setting: a float (toggle 0 or 1, choice the option's index, range the value) or a `vec3` (color). Any character of the setting id outside `A-Za-z0-9_` becomes `_`, so the setting `glow-size` is `uSetting_glow_size` |

The helpers are `band(x)` (the spectrum at `x` in 0..1, interpolated), `hash21`, `vnoise`, `fbm`, `pal(x)`
(the palette at `x` in 0..2), `coverCenter()`, `coverQ`, `stageUv`, `luma`, `sdRound`, `disc`, `vig`, `settle` and
`hushAt`. The constants are `PI` and `TAU`. Read the text from `plistoVis.PRELUDE`, `plistoVis.FLUID_PRELUDE`
and `plistoVis.COZY_PRELUDE` when you want it exactly.

Do not declare a name the prelude already has, or the compile fails. That includes every uniform and helper
above, the constants `PI` and `TAU`, `vUv` (the input), `outColor` (the output) and `rings` (a helper function
of the prelude, so a variable of that name clashes).

A shader file gets the default look settings. To set `mode`, `bloom`, `exposure`, `inkGain` or `vignette`,
declare a `page` instead of a `shader` and call `plistoVis.shader(spec)` from its script:

```js
plistoVis.shader({ source: "void main() { outColor = vec4(0.0, 0.0, 0.0, 1.0); }", mode: "glow", bloom: 0.4 });
```

`source` is the text that follows the prelude: the same as a `.frag` file. `mode` is `"glow"` or `"image"`.

See [`starters/shader`](starters/shader) and [`examples/level-glow`](examples/level-glow).

### scene

The manifest names a `page`. The page's script calls `plistoVis.scene(spec)` once:

```js
plistoVis.scene({
  passes: [{ name: "scene", fs: plistoVis.SCENE_PRELUDE + "...your main()..." }],
  init: (kit) => ({ travel: 0 }),
  update: (frame, state) => { state.travel += frame.dt; },
  uniforms: (pass, program, kit, frame, state) => kit.set1(program, "uTravel", state.travel),
});
```

- `passes` run in order. Each gets the scene uniforms plus the ones you set in `uniforms`. The last pass
  draws to the stage; every other pass draws into a buffer of its own.
- A pass name must be a valid GLSL identifier, not `main`, and not start with `gl_`, because an input
  pass is bound as a sampler of that name. Plisto refuses a scene with a bad name.
- `feedback: true` keeps the pass's previous output. Declare `uniform sampler2D uPrev;` in the pass to read it.
- `inputs` lists earlier passes this one samples. Declare one `uniform sampler2D` per input, named after the
  pass.
- `scale` (0..1) draws a pass into a buffer at that share of the stage size. `uRes` stays the stage size in
  that pass, so use `uPassRes` (declare `uniform vec2 uPassRes;`) for the size of the buffer you are drawing
  into, and divide `gl_FragCoord` by it, not by `uRes`, to get 0..1 coordinates.
- `blend: "add"` adds a pass's output to its buffer instead of replacing it.
- `init`, `update` and `dispose` keep your state. `update` gets the whole [frame](docs/feed.md) and may
  return a number, which becomes `uFlow`.
- `trail`, `bloom`, `exposure`, `inkGain`, `vignette` and `mode` set how Plisto finishes the picture.
  `mode` is `"glow"` (light, the default) or `"image"` (real color). `rings` gives `{ life, rise, height }`
  for the `uRings` uniform.

`plistoVis.SCENE_PRELUDE` is the text every `fs` starts with. It is not the shader form's prelude. It is
the fluid prelude (the uniforms and helpers above, without `disc`, `vig`, `uFine`, `uPrev` and
`uSetting_*`) followed by exactly this:

```glsl
uniform float uLevel;
const float uBackdrop = 0.0;
```

See [`starters/scene`](starters/scene) and [`examples/band-tunnel`](examples/band-tunnel).

### candidate

The page's script calls `plistoVis.candidate(factory, { programs })`. The factory receives the `Kit` and
returns a candidate: its look (`mode`, `bloom`, `exposure`, `inkGain`, `trail`), `draw(frame)` and `dispose()`.
All of these are required; `dispose` frees what the factory created. This is
how Plisto's own kinds are written. The kit's [`fixtures/`](fixtures) folder holds ports of them; open one to
see a real kind.

- `kit.program({ name, vs, fs })` returns a program. Use `plistoVis.FS_VS` as `vs`. Compiling takes a
  moment, so list the programs you draw with in `options.programs`: Plisto compiles them together before
  the first frame.
- Never wrap `kit.program` in a `try` block. While a program is still compiling it throws, and the runtime
  catches that to retry the frame.
- Use `kit.setCommon(program, frame)` to set the common uniforms, `kit.set1`, `set2`, `set4`, `seti` and
  `bindTex` for your own, `kit.drawQuad()` to draw, and `kit.makeTarget` and `kit.bindTarget` for buffers.
- `plistoVis` also exports the scene helpers the built-in kinds use: `createCoverTexture`, `createRings`,
  `setFluid`, `createDots`, `createBeatClock` and the signal helpers. [`types/plisto-vis-1.d.ts`](types)
  lists them all.

See [`starters/candidate`](starters/candidate) and [`examples/lake`](examples/lake).

### raw

The page's script calls `plistoVis.raw(handlers)`:

| Handler | When it runs |
| --- | --- |
| `setup(ctx)` | Once. Create your canvas or DOM here. Return the canvas you draw on |
| `frame(frame)` | For every frame to draw. Plisto reads the returned canvas after it |
| `resize(layout)` | The stage changed size |
| `theme(ctx)` | The light or dark theme, the palette, the colors or the cover changed |
| `settings(values)` | A setting changed |
| `still(frame)` | Optional. Draw the still, or return it as an ImageBitmap |
| `dispose()` | Tear down |

Return your canvas from `setup` and Plisto takes the still from it and watches it for flashing after each
`frame` call. A raw kind that has no canvas and no `still` shows nothing under reduced motion, and the
catalog says so. A kind that draws outside `frame`, for example on its own animation frame loop, registers
its canvas with `plistoVis.meter`. See [The meter](#the-meter).

See [`starters/raw`](starters/raw).

## The manifest block

A visualizer plugin's `plugin.json` has the usual fields (see the [manifest reference](../docs/manifest.md)),
no `entry` unless the plugin has a page of its own, the capability `visualizer` and a `visualizers` list:

```json
{
  "manifest_version": 1,
  "id": "com.example.rings",
  "name": "Rings",
  "version": "1.0.0",
  "tier": "ui",
  "capabilities": ["visualizer"],
  "min_plisto": "2.8.0",
  "author": "Your Name",
  "visualizers": [
    {
      "id": "aurora-rings",
      "name": "Aurora rings",
      "api": 1,
      "page": "vis/rings.html",
      "look": {
        "light": { "composite": "ink", "blend": "multiply" },
        "dark": { "composite": "light", "blend": "screen" }
      },
      "fills_stage": false,
      "needs": { "cover": true },
      "aliases": ["rings"],
      "settings": [
        { "id": "tint", "label": "Tint", "type": "color", "default": "cover" }
      ],
      "presets": [
        { "id": "calm-blue", "label": "Calm blue", "values": { "tint": "#3a6ea5" } }
      ]
    }
  ]
}
```

The `visualizer` capability and the `visualizers` list always come together. Each entry:

| Field | Rule |
| --- | --- |
| `id` | 1 to 24 characters of `a-z`, `0-9` and `-`. Unique in the plugin, aliases included |
| `name` | The name in the catalog, 1 to 24 characters of plain text |
| `api` | `1` |
| `page` or `shader` | Exactly one. `page` is an `.html` file and `shader` is a `.frag` or `.glsl` file, both inside the plugin folder. Neither may start with `_plisto` |
| `look` | How Plisto maps the picture onto the stage; see below |
| `fills_stage` | Optional, default false. True when the kind paints every pixel of the stage, not just a layer over it |
| `dark_only` | Optional, default false. True when the kind only works on a dark ground; it is drawn dark in a light theme |
| `needs` | Optional. `fine` (the 128-band spectrum), `cover` (the cover's pixels), `pointer` (the pointer position), `waveform` (see below). Each defaults to false |
| `aliases` | Optional, up to 4 former ids. A stored choice that names an alias resolves to this kind, so renaming a kind does not lose users' choices |
| `settings` | Optional, up to 8. Controls in the Player's sheet |
| `presets` | Optional, up to 6. Named bundles of setting values |

A plugin can list up to 8 kinds.

**look.** `"glow"` is light: on a dark theme it is added to the stage, on a light theme it is drawn as ink.
`"image"` paints real color and is drawn as it is. For other mixes give a pair per theme: `composite` is
`light`, `ink` or `image` (how Plisto tone-maps the picture) and `blend` is any CSS `mix-blend-mode`
keyword (how the layer sits over what is behind it).

**settings.** Each has an `id` (same rule as a kind id), a `label` (1 to 24 characters), a `type` and an
optional `default`:

- `choice` with 2 to 8 `options`, each `{ "id", "label" }`. The value is an option id.
- `toggle`. The value is a boolean.
- `range` with `min`, `max` and `step`. The value is a number in the range.
- `color`. The value is `#rrggbb`, or `cover` for the cover palette.

Without a default a setting starts at its first option, off, its minimum, or `cover`. A preset's `values`
name settings of the same kind and give values they accept.

**needs.waveform** asks for 256 samples of the waveform in each frame. It needs the capability
`visualizer.waveform` next to `visualizer`, and Plisto only sends it while such a kind is shown.

Plisto refuses a manifest that breaks a rule and says which field. Fix it and install again.

## Capabilities

A visualizer frame can use these, and only these:

| Capability | What it lets the frame do |
| --- | --- |
| `visualizer` | Required. Draw in the Player, and read the feed |
| `visualizer.waveform` | Receive the waveform window of kinds that ask for it. Needs `visualizer` |
| `storage` | `plistoVis.storage`: the plugin's own saved data |
| `playback.read` | `plistoVis.call("playback.state")`: what is playing |
| `library.read` | `plistoVis.call` with the `library.*` read methods |

`plistoVis.log.info(text)` writes to the plugin's log. A frame has no events, streams, sockets, sidebar,
toasts, prompts or network: those need a page or a background frame of the plugin.

Ask only for what you use. Each capability is a line the user reads at install.

## Where your plugin is listed

A plugin that only adds visualizers lives in Settings, Visualizers. It does not appear in the plugins list.
Its family in the catalog has the on and off switch, its details, Uninstall... and, in developer mode, Reload
from source and Open log.

A plugin is visualizer-only when all of these hold:

- its tier is `ui`;
- it lists at least one visualizer and holds `visualizer`;
- it has no `entry` and no `sidebar`;
- every capability is one of `visualizer`, `visualizer.waveform`, `storage`, `playback.read` and
  `library.read`.

A plugin with anything else is also in the plugins list: a page of its own, a sidebar entry, the native tier,
`background`, `network`, a `ui.*` capability, `playback.control` or `playback.stream`. Its visualizers join the
catalog all the same, under a family named for the plugin, and the family says where to manage it.

The listing follows the installed manifest. If an update crosses the line, in either direction, Plisto shows
a notice that the plugin has moved and where to find it. Stored choices and saved data stay as they are.

## The meter

Plisto's flash meter reads the stage canvas and watches it for flashing. The runtime does the work:

- A shader, scene or candidate kind is metered automatically, with nothing for you to do.
- A raw kind's canvas, when you return it from `setup`, is metered after each `frame` call.
- If a raw kind draws outside its `frame` handler, for example on its own animation frame loop, register the
  canvas yourself and call `frame()` on the result after each draw:

```js
const meter = plistoVis.meter(canvas);
// after each draw:
meter.frame();
// when you tear down:
meter.dispose();
```

The meter runs only while Plisto turns it on: when the user has turned on "Stop plugin visualizers that
flash" in Settings, Visualizers, or when developer mode is on, where it only logs readings. Calling
`frame()` while it is off costs nothing. The meter only reads. It never changes what you draw, and by
default Plisto does nothing with a reading.

A raw kind that registers no canvas, by either path, is not watched, and the catalog tells the user so while
the setting is on. The rule, what to avoid and a worked example are on the
[photosensitivity page](docs/photosensitivity.md).

## What the user is told at install

The review sheet is the same for every UI plugin. For a visualizer plugin it adds:

- For `visualizer`: "Draw visualizers in the Player. While one is shown it runs and sees your music's
  levels and the cover of what is playing."
- For `visualizer.waveform`: "See brief snapshots of the sound wave of what is playing."
- When the plugin also holds `network`: "It can send what it reads here, such as your library or what is
  playing, to these sites."
- For every visualizer plugin: "Plisto does not check plugin visualizers for flashing. It stops one that
  stops responding. You can have Plisto stop one that flashes in Settings, Visualizers."
- Where the plugin will be listed: "It will be listed in Visualizers." or "It will be listed in Plugins, and
  its visualizers will appear in Visualizers."

Consent is the gate. Once the user has turned the plugin on, a kind is picked, previewed and cycled with
the V key exactly like a built-in one, with no extra prompt. Plisto still stops a kind that stops
responding, that starves its frames or that loses the graphics context repeatedly, and it marks the kind.

## What stays the same: api 1

A kind that declares `"api": 1` gets the api 1 runtime and draws the same way for as long as Plisto serves
that api. The rule has three parts:

- **Signatures.** Everything on `plistoVis` is listed in [`types/plisto-vis-1.d.ts`](types). Plisto may add
  to it. It never removes a member or changes one.
- **Values.** The shader preludes, the constants and the tables are api surface too. Their text and
  numbers do not change.
- **Looks.** Plisto renders the ports of its own kinds in `fixtures/`, and the `lake` example, through the
  runtime and compares the result with a recorded one. A change to a helper that moves a pixel fails that
  check.

When Plisto's own kinds need a helper to change, the old helper is kept as a frozen copy in Plisto's source
under `gl/api1/` and the api 1 runtime points at it. Plisto's kinds move on. Your plugin does not move under
you. New abilities arrive as a new api number that a kind opts into in its manifest.

## Types in your editor

For plain JavaScript, add a reference to the types and turn on checking at the top of a script:

```js
// @ts-check
/// <reference path="path/to/plugin-kit/visualizers/types/plisto-vis-1.d.ts" />
```

The file declares the global `plistoVis` and every frame shape. If you prefer TypeScript, compile with any
tool you like: Plisto does not need a build step.

## What is in this folder

| Path | What it holds |
| --- | --- |
| `README.md` | This page |
| `docs/feed.md` | Every field of the frame and what it means. Generated from the types |
| `docs/photosensitivity.md` | The flashing rule, the setting, advice and the raw meter |
| `docs/check.md` | The checker: manifest, compile, a scripted run, a still and the listing |
| `check-visualizer.mjs` | The command that runs the checker on a plugin folder |
| `starters/` | One minimal plugin per form |
| `examples/` | Three finished plugins |
| `fixtures/` | Ports of Plisto's own kinds, as candidate scripts, to read and learn from |
| `types/plisto-vis-1.d.ts` | Types for `plistoVis` |
| `types/surface-1.json` | The api 1 surface, by export |
| `runtime/` | A copy of the runtime Plisto serves, for tools that run a kind outside Plisto |
| `lib/` | Copies of the frame protocol and the browser runner, for the same tools |
