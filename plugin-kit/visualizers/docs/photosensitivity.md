# Photosensitivity

Rapid flashing can cause seizures in people with photosensitive epilepsy. This page says what Plisto's own
visualizers promise, what Plisto does and does not do about a plugin's visualizers, and how to stay on the
safe side when you write one.

## What Plisto promises for its own visualizers

Plisto's built-in visualizers are built to never flash a large area more than 3 times a second. Plisto
measures them with its own flash check during development, and the red-heavy kinds also get a red check.

## What Plisto does for a plugin visualizer

- **The install sheet warns the user.** Before a plugin that draws visualizers is turned on, Plisto tells
  the user that it does not check plugin visualizers for flashing. That warning is the gate.
- **Nothing stops a working visualizer by default.** A visualizer that draws what it was written to draw
  keeps running. Plisto does not limit what you can draw.
- **The user can ask Plisto to stop flashing visualizers.** In Settings, Visualizers, the setting "Stop
  plugin visualizers that flash" is off by default. When the user turns it on, Plisto watches each
  visualizer's canvas. If it flashes past the line below, Plisto stops it, marks it "Stopped by Plisto:
  flashing" and offers "Turn back on".
- **Plisto still stops a visualizer that stops responding.** That is separate from flashing and is always on.

Because the check is the user's choice, the safe default has to come from you.

## The line

The meter reads the canvas as a 64 by 36 grid, about 20 times a second. A flash is a rise and a fall in
brightness, each a step of at least 10 percent of full brightness. A step only counts when the darker end of
it is below 80 percent of full brightness, so a swing between two very bright levels does not count.
A reading breaks the line when:

- a window one third of the stage wide and one third high flashes more than 3 times in a second over a
  quarter of its area, or
- any flash is a saturated red flash.

The numbers can be tuned in later Plisto versions. Aim well below them.

## Staying under the line

Drive large areas of light from the slow fields of the signal. Drive motion and small details from the fast
ones. The [feed reference](feed.md) lists every field; these are the ones that matter here.

| Use for large-area brightness | Do not use for large-area brightness |
| --- | --- |
| `level`, `loudness`: eased over about a second, so they cannot flash | `rms`, `peak`: jump on every hit |
| `swell`: slow motion | `kick`, `flux`: one-frame pulses |
| | `bassHit`, `midHit`, `highHit`: not rate-capped, several can rise from rest in one second |

`beat` and `beatWeight` fire at most 3 times a second, so light hung on a beat stays within the line, but only
if it is one flash per beat. Do not add a second pulse on top of each beat.

Practical rules:

- Make the beat move something, not light everything. Scale a shape, push a ring outward or nudge a color
  instead of switching the whole stage from dark to bright.
- Keep the flash area small. The line counts the share of a third-of-the-stage window, so a thin line or a
  small shape that pulses is far from it.
- Ease every pulse. A quick rise and a slower fall read as a swell, not a flash.
- Keep contrast between the two states low. A step below 10 percent of relative brightness is not a flash.
- Avoid saturated red for anything that pulses. The red check has no allowance at all.
- Do not strobe on a timer. A fixed `sin(t * 20.0)` flickers at 3 Hz or faster whatever the music does.
- Under Calm, `beat`, `beatWeight`, `drive` and the `*Motion` and `*Hit` fields read 0. Make sure your kind still
  looks alive from `level`, `swell` and time alone.
- Under reduced motion, hold still and draw one frame.

## The meter and your kind

The runtime watches the canvas of every form:

- A scene, shader or candidate kind is watched automatically. You do nothing.
- A raw kind is watched when you return its canvas from `setup`. Plisto reads it after each `frame` call.
- A raw kind that draws outside its `frame` handler, for example on its own animation frame loop, registers
  its canvas with `plistoVis.meter(canvas)` and calls `frame()` on the result after each draw.

```js
let canvas = null;
let meter = null;

const draw = () => {
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "rgba(120, 120, 120, 0.4)";
  g.fillRect(0, 0, canvas.width * Math.random(), canvas.height);
  // Tell the meter a frame is on the canvas, in the same task that drew it.
  meter.frame();
  requestAnimationFrame(draw);
};

plistoVis.raw({
  setup() {
    canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    meter = plistoVis.meter(canvas);
    draw();
  },
  frame() {},
  dispose() {
    meter.dispose();
    canvas.remove();
  },
});
```

The meter runs only while Plisto turns it on: the user's setting "Stop plugin visualizers that flash", or
developer mode, where it only logs readings. Calling `frame()` while it is off costs nothing. The meter only
reads; it never changes what you draw.

A raw kind that registers no canvas by either path is not watched. While the setting is on, the catalog tells
the user so.

The meter works on a WebGL canvas and on a 2D canvas. A kind built from DOM or SVG has no canvas to give it;
it cannot be watched, so keep its motion gentle.

## Checking your own work

- Turn on developer mode in Plisto. The meter then runs whatever the user's setting says, and only logs
  readings; it never stops anything. Play something loud and busy and read the log.
- Test with music that has hard transients: a drum break, a loud drop, clicks.
- Check with Calm, Balanced and Lively. Lively scales the fast fields up.
- Look at the still frame. It is what a user who asked for reduced motion sees.

## What to put in your description

If your visualizer is meant to strobe, say so in the plugin's name or its page. Users decide with the
install warning; give them the information.
