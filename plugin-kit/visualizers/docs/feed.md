# The feed

This page lists every field a visualizer frame receives and what it means. It is generated from
`types/plisto-vis-1.d.ts`; do not edit it by hand.

A kind reads these fields in `frame` (raw), in `update` and `uniforms` (scene) and in `draw` (candidate).
A shader kind reads them as uniforms instead; see the [README](../README.md).

## VisFrame

What `frame` receives in a raw kind, and what the scene form passes to `update` and `uniforms`. It holds everything in `Frame`, then what only the feed knows.

| Field | Type | Meaning |
| --- | --- | --- |
| `settings` | `Record<string, VisSettingValue>` | The current value of each setting the kind declares, by setting id. A toggle is a boolean, a range a number, a choice the id of its option, a color a `#rrggbb` string or `cover`. |
| `rawBands` | `number[]` | The latest 24 bands from the audio engine, before any smoothing, about 30 times a second. Empty on a still frame. Use it when you want your own ballistics. |
| `nBeats` | `number` | How many beats fired since the last frame you drew. Usually 0 or 1; more than 1 after a slow frame, so no beat is lost. |
| `beatAt` | `number \| null` | The playback position, in seconds, of the latest beat, or null before the first one. |
| `trackSeq` | `number` | A counter that goes up each time the track changes. It carries no track identity; reset your state when it moves. |
| `pointer` | `VisPointer \| null` | The pointer over the stage when the kind declares `needs.pointer`, otherwise null. |
| `wave` | `Float32Array \| null` | 256 samples of the waveform in -1..1, a short window of what is playing. Present only when the kind declares `needs.waveform` and the plugin holds the `visualizer.waveform` capability, otherwise null. |
| `colors` | `VisColors` | The stage colors: ground, backing and ink. |

## Frame

The part of the frame that every kind shares, including the candidate form's `draw(frame)`.

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | `number` | Time in seconds, for animation phase. A still frame uses a fixed time. |
| `dt` | `number` | Seconds since the last frame you drew, at most 0.05. After a long pause you get one clamped step, never a long jump. |
| `sig` | `VisualSignal` | The audio signal. See the table below. |
| `palette` | `Float32Array` | Three sRGB colors from the cover, flattened to 9 numbers in 0..1. |
| `light` | `boolean` | True when the theme is light. A kind that declares `dark_only` sees false in a light theme. |
| `ambient` | `boolean` | True when the kind draws behind the whole app instead of in the Player. Ambient draws softer and settles toward the ground at its corners. |
| `still` | `boolean` | True when this frame is for the still image (the catalog tile, reduced motion). Draw a representative frame, with no history. |
| `playing` | `boolean` | True while the track plays. When it is paused the signal's `drive` keeps its gain, so a kind that must hold still when paused reads this. |
| `fine` | `number[] \| null` | The smoothed 128-band spectrum when the kind declares `needs.fine`, otherwise null. Fall back on the 24 bands when it is null. |
| `cover` | `ImageBitmap \| null` | The cover as an ImageBitmap, flipped for GL, when the kind declares `needs.cover` and the track has art. Otherwise null. |
| `mirrored` | `boolean` | Always false in a plugin frame. Declare a setting such as `layout` instead, and read it from `settings`. |
| `backing` | `[number, number, number]` | The ground under a cover-sized dot matrix: paper on light, near black on dark. |
| `ground` | `[number, number, number]` | The stage's own ground color: the panel surface in the Player, the base ground in ambient. |
| `progress?` | `number \| null` | The track position over its duration in 0..1, or null when it is unknown. |

## VisualSignal

The audio signal, in `frame.sig`. Plisto has already applied the user's Calm, Balanced or Lively setting. Every value is a number in 0..1 unless the table says otherwise.

| Field | Type | Meaning |
| --- | --- | --- |
| `bands` | `Float32Array` | The 24 band levels, low to high, with the Player's fast attack and slow decay. |
| `rms` | `number` | The overall level with a fast attack and a slow decay. It jumps; do not hang large-area brightness on it. Use `level`. |
| `peak` | `number` | The peak level with the same easing as `rms`. |
| `flux` | `number` | The engine's onset flux, held briefly so one frame's rise survives to the next draw. |
| `kick` | `number` | A pulse that jumps on a beat and decays fast. Motion only, never brightness. |
| `bass` | `number` | The level of the low band group. |
| `mid` | `number` | The level of the middle band group. |
| `high` | `number` | The level of the high band group. |
| `level` | `number` | The rms eased over about a second. The steady brightness driver: it moves too slowly to flash. |
| `swell` | `number` | The bass eased over about a second. Slow motion. |
| `bassMotion` | `number` | A fast-attack, medium-release envelope of the low group's rise over its recent mean. Motion only, and 0 under Calm. |
| `midMotion` | `number` | The same envelope for the middle group. |
| `highMotion` | `number` | The same envelope for the high group. |
| `beat` | `number` | A beat's strength on the frame it fires, otherwise 0. At most 3 a second, scaled by the reactivity gain, and 0 under Calm. It can exceed 1 under Lively. |
| `drive` | `number` | The reactivity gain: 0 under Calm, 1 under Balanced, 1.6 under Lively. Scale motion terms that are not an envelope by it. |
| `loudness` | `number` | Absolute loudness in 0..1, the rms in dBFS through a fixed window and eased. It tells a quiet master from a loud one, and stays live under Calm. |
| `bassHit` | `number` | A transient envelope for the low group: near 0 between hits, near 1 on a clear hit. Not rate-capped, so use it for motion and small features, never large-area light. 0 under Calm, up to 1.6 under Lively. |
| `midHit` | `number` | The same transient envelope for the middle group. |
| `highHit` | `number` | The same transient envelope for the high group. |
| `beatWeight` | `number` | How much a beat deserves to show: high for a loud, bass-led onset that stands out from the recent ones. It is held for a short span after `beat` fires, then reads 0. Rate-capped with `beat`. |
| `surge` | `number` | A loudness jump on the frame it is detected, otherwise 0: a drop landing. Rare. |
| `cut` | `number` | A loudness fall on the frame it is detected, otherwise 0: the music dropping away. Rare. |

## VisPointer

The pointer over the stage, in `frame.pointer`. Position only: there are no clicks.

| Field | Type | Meaning |
| --- | --- | --- |
| `x` | `number` | Horizontal position over the stage, 0 at the left edge to 1 at the right. |
| `y` | `number` | Vertical position over the stage, 0 at the top edge to 1 at the bottom. |
| `inside` | `boolean` | True while the pointer is over the stage. |

## VisColors

The stage colors, in `frame.colors` and `context.colors`. Each is sRGB with channels in 0..1.

| Field | Type | Meaning |
| --- | --- | --- |
| `ground` | `VisRgb` | The stage ground. |
| `backing` | `VisRgb` | The ground under a cover-sized dot matrix. |
| `ink` | `VisRgb` | The color to draw lines and text in so they read on the ground. |

## VisContext

The state that changes rarely. It reaches `setup` once. Afterward a raw kind hears `resize` when the layout changes, `settings` when a setting changes and `theme` when the light or dark theme, the palette, the colors or the cover change. A change to ambient, reactivity or reduced motion calls no handler.

| Field | Type | Meaning |
| --- | --- | --- |
| `layout` | `VisLayout` | The stage and cover geometry. See the table below. |
| `palette` | `Float32Array` | The cover palette, as in `frame.palette`. |
| `cover` | `ImageBitmap \| null` | The cover as an ImageBitmap, or null. |
| `colors` | `VisColors` | The stage colors. |
| `light` | `boolean` | Whether the kind draws light: false for a dark-only kind in a light theme. |
| `reactivity` | `"calm" \| "balanced" \| "lively"` | The user's reactivity level. The signal already reflects it; read it only to decide what to draw. |
| `ambient` | `boolean` | Whether the kind draws behind the whole app. |
| `reducedMotion` | `boolean` | True when the user asked for reduced motion. Hold still. |
| `settings` | `Record<string, VisSettingValue>` | The current setting values, as in `frame.settings`. |

## VisLayout

Where the stage and the cover sit. All values are CSS pixels relative to the frame, with the origin at the top left.

| Field | Type | Meaning |
| --- | --- | --- |
| `width` | `number` | The stage width. |
| `height` | `number` | The stage height. |
| `cover` | `VisRect` | The cover's rect: left, top, width, height. |
| `radius` | `number` | The cover's corner radius. |
| `mask` | `VisRect \| null` | The rect the layer feathers off outside, or null to draw the whole stage. |
| `floor` | `number \| null` | The top edge of the element the layer rests on, or null for none. |
| `hush` | `VisRect[]` | Rects of text blocks the layer may soften behind, so labels stay readable. |
