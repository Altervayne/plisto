# The harness

The harness is a local page that runs your visualizer on Plisto's runtime, the same file the app serves, in a
sandboxed frame, fed over the same protocol. You change the theme, the layout, the reactivity and your own
settings and watch it respond, with a readout of what the frame reports. It needs Node and a browser. It
serves on 127.0.0.1 only and loads nothing from the network.

```powershell
node plugin-kit/sdk/mock-serve.mjs 8765 .\my-visualizer --watch
```

Then open `http://127.0.0.1:8765/visualizers/harness/index.html` (the command prints it). The folder is a
plugin folder with a `plugin.json` that declares `visualizers`. A manifest Plisto would refuse is shown with
its refusal line instead of the stage. Port `0` picks a free one.

`--watch` is off unless you give it. With it, a change to a file inside your plugin folder reloads the page
once the writes settle. Files outside the folder, dotfiles and `node_modules` do not count. The controls you
set come back after the reload.

## What you see

The stage is the frame at the size of the chosen layout (scaled down to fit the page, never scrolled), over
a soft color bloom in the cover's palette that stands in for the app's backdrop. The frame is blended onto
it with your kind's own blend for the theme: a `glow` look is `screen` on dark and `multiply` on light, an
`image` look is `normal`, and a pair gives what you declared. The cover and the text blocks of the layout
sit above the frame, except for a kind that declares `fills_stage`, which draws its own cover. "Show layout
guides" outlines the cover, the mask and the floor.

## Controls

| Control | What it changes |
| --- | --- |
| Kind | Which declared kind runs, when the plugin has more than one |
| Feed | Where the ticks come from: scripted, recorded or an audio file. See below |
| Playing | `playing` in the tick. A paused track keeps `drive`, so a kind that must hold still reads this |
| Theme | `context.light` and the stage `colors`. A `dark_only` kind sees `light: false` and a dark stage |
| Reactivity | `context.reactivity` and the signal: Calm zeroes the motion channel (`drive`, `beat`, the motion and hit envelopes, `surge`, `cut`) and counts no beat, Balanced passes it, Lively raises it by 1.6 |
| Layout | `context.layout` and `context.ambient`: Player, Ambient (no mask or floor), Compact, Portrait |
| Reduced motion | `context.reducedMotion`. Use "Show the still" for the picture a reduced-motion user gets |
| Flash meter | Sends the runtime's meter switch. Off, the readout says "meter off" |
| Simulate a hidden slot | Withholds ticks as Plisto does when the slot is not visible. The held ticks fold into one |
| Kind settings | One control per declared setting, the presets as buttons, and a reset. Each change is a `settings` update |
| Restart the kind | A fresh mount: init, compile and first frame again |
| Channel | Plays the page: sends JSON to the frame, lists what it sends back. See [channel](channel.md) |

A change reaches the frame as `{type: "update", context}` carrying only the fields that differ. The frame
hears `resize`, `settings` or `theme` as it would in the app; a change to ambient, reactivity or reduced
motion calls no handler, as documented in the [feed reference](feed.md).

## Feeds

- **Scripted.** The checker's own feed: a beat every half second, bands sweeping the spectrum, a breathing
  level, one surge at 4 s and one cut at 8 s. Reactivity applies to it.
- **Recorded ticks.** A JSON file: an array of ticks, or an object with a `ticks` array. Each tick has `t`,
  `dt` and `sig` (the [signal](feed.md#visualsignal), with `sig.bands` as a list of numbers), and may have
  `nBeats`, `beatAt`, `rawBands`, `fine`, `playing`, `trackSeq`, `progress` and `wave`. Missing fields read
  as 0, null or false. The file loops. A display frame that spans several recorded ticks gets them folded
  into one, so no beat is lost, and a frame inside a tick already sent repeats no event. A recording is
  played as it is: the Reactivity control still changes the context, but the recorded signal was shaped when
  it was captured.
- **Audio file (approximate).** A local audio file played through Web Audio and analysed in the page: 24
  log-spaced bands, an onset-based beat at most three a second, a level, motion and hit envelopes, and a
  waveform window. It is a stand-in. Plisto's engine analysis is different, so judge reactions on real music
  in the app. The file never leaves the page.

The pointer, when your kind declares `needs.pointer`, is the mouse position over the stage.

## Readout

| Row | Meaning |
| --- | --- |
| Ready | Time from sending the init to the first shown frame |
| Ticks sent, acked, in flight | The host's counts. At most 2 are in flight; the frame acks each tick it consumes |
| Folded while hidden | Ticks withheld and folded while the slot was not visible |
| Step cost, median, worst | The milliseconds the frame reports with its acks |
| Flashing | "meter off", "not watched (no canvas registered)", "under the limit" (the meter reports only when it trips, so a quiet kind sends no reading), or the trip reading marked "over the limit" |
| Finding | The checker's limits applied to the window of acks: flashing, red flash, slow median step |

A reading the frame never gave shows as "no reading", never 0. Silence is not judged as a hang here: a frame
in a hidden or throttled tab goes quiet while healthy. `check-visualizer.mjs` runs the hang rule on a scripted
run. See [check your visualizer](check.md) for the limits and [photosensitivity](photosensitivity.md) for what
the flash numbers mean.

## What it is not

It is not the app. The backdrop is a stand-in, the signal is not Plisto's engine analysis, and the frame is
on a second port of 127.0.0.1 rather than Plisto's own origin. It does run the real runtime, the real
protocol and your files unchanged, with the same frame policy: scripts and requests from the frame's own
origin only.
