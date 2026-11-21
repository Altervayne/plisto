// What each member of the feed's types means, in the words the kit's feed reference prints. Keyed by
// `Interface.member` of plugin-kit/visualizers/types/plisto-vis-1.d.ts. tools/kit-feed.mjs fails when a
// member has no entry here, and when an entry names a member that no longer exists.

/** The reference sections, in print order: the interface and the sentence that opens its table. */
export const SECTIONS = [
  ["VisFrame", "What `frame` receives in a raw kind, and what the scene form passes to `update` and `uniforms`. It holds everything in `Frame`, then what only the feed knows."],
  ["Frame", "The part of the frame that every kind shares, including the candidate form's `draw(frame)`."],
  ["VisualSignal", "The audio signal, in `frame.sig`. Plisto has already applied the user's Calm, Balanced or Lively setting. Every value is a number in 0..1 unless the table says otherwise."],
  ["VisPointer", "The pointer over the stage, in `frame.pointer`. Position only: there are no clicks."],
  ["VisColors", "The stage colors, in `frame.colors` and `context.colors`. Each is sRGB with channels in 0..1."],
  ["VisContext", "The state that changes rarely. It reaches `setup` once. Afterward a raw kind hears `resize` when the layout changes, `settings` when a setting changes and `theme` when the light or dark theme, the palette, the colors or the cover change. A change to ambient, reactivity or reduced motion calls no handler."],
  ["VisLayout", "Where the stage and the cover sit. All values are CSS pixels relative to the frame, with the origin at the top left."],
];

/** The interfaces of the types that are not part of the feed. A new interface must be listed here or in SECTIONS. */
export const NOT_FEED = [
  "Trail", "Candidate", "ProgramSource", "Program", "Target", "Geometry", "Kit", "ShaderSpec", "ScenePass", "SceneSpec",
  "CandidateOptions", "RawHandlers", "StageMeter", "BeatClock", "CosmicPunch", "CoverTexture", "CyberBeatState", "Dots",
  "ReactivityProfile", "Rings",
];

export const MEANINGS = {
  "VisFrame.settings": "The current value of each setting the kind declares, by setting id. A toggle is a boolean, a range a number, a choice the id of its option, a color a `#rrggbb` string or `cover`.",
  "VisFrame.rawBands": "The latest 24 bands from the audio engine, before any smoothing, about 30 times a second. Empty on a still frame. Use it when you want your own ballistics.",
  "VisFrame.nBeats": "How many beats fired since the last frame you drew. Usually 0 or 1; more than 1 after a slow frame, so no beat is lost.",
  "VisFrame.beatAt": "The playback position, in seconds, of the latest beat, or null before the first one.",
  "VisFrame.trackSeq": "A counter that goes up each time the track changes. It carries no track identity; reset your state when it moves.",
  "VisFrame.pointer": "The pointer over the stage when the kind declares `needs.pointer`, otherwise null.",
  "VisFrame.wave": "256 samples of the waveform in -1..1, a short window of what is playing. Present only when the kind declares `needs.waveform` and the plugin holds the `visualizer.waveform` capability, otherwise null.",
  "VisFrame.colors": "The stage colors: ground, backing and ink.",

  "Frame.t": "Time in seconds, for animation phase. A still frame uses a fixed time.",
  "Frame.dt": "Seconds since the last frame you drew, at most 0.05. After a long pause you get one clamped step, never a long jump.",
  "Frame.sig": "The audio signal. See the table below.",
  "Frame.palette": "Three sRGB colors from the cover, flattened to 9 numbers in 0..1.",
  "Frame.light": "True when the theme is light. A kind that declares `dark_only` sees false in a light theme.",
  "Frame.ambient": "True when the kind draws behind the whole app instead of in the Player. Ambient draws softer and settles toward the ground at its corners.",
  "Frame.still": "True when this frame is for the still image (the catalog tile, reduced motion). Draw a representative frame, with no history.",
  "Frame.playing": "True while the track plays. When it is paused the signal's `drive` keeps its gain, so a kind that must hold still when paused reads this.",
  "Frame.fine": "The smoothed 128-band spectrum when the kind declares `needs.fine`, otherwise null. Fall back on the 24 bands when it is null.",
  "Frame.cover": "The cover as an ImageBitmap, flipped for GL, when the kind declares `needs.cover` and the track has art. Otherwise null.",
  "Frame.mirrored": "Always false in a plugin frame. Declare a setting such as `layout` instead, and read it from `settings`.",
  "Frame.backing": "The ground under a cover-sized dot matrix: paper on light, near black on dark.",
  "Frame.ground": "The stage's own ground color: the panel surface in the Player, the base ground in ambient.",
  "Frame.progress": "The track position over its duration in 0..1, or null when it is unknown.",

  "VisualSignal.bands": "The 24 band levels, low to high, with the Player's fast attack and slow decay.",
  "VisualSignal.rms": "The overall level with a fast attack and a slow decay. It jumps; do not hang large-area brightness on it. Use `level`.",
  "VisualSignal.peak": "The peak level with the same easing as `rms`.",
  "VisualSignal.flux": "The engine's onset flux, held briefly so one frame's rise survives to the next draw.",
  "VisualSignal.kick": "A pulse that jumps on a beat and decays fast. Motion only, never brightness.",
  "VisualSignal.bass": "The level of the low band group.",
  "VisualSignal.mid": "The level of the middle band group.",
  "VisualSignal.high": "The level of the high band group.",
  "VisualSignal.level": "The rms eased over about a second. The steady brightness driver: it moves too slowly to flash.",
  "VisualSignal.swell": "The bass eased over about a second. Slow motion.",
  "VisualSignal.bassMotion": "A fast-attack, medium-release envelope of the low group's rise over its recent mean. Motion only, and 0 under Calm.",
  "VisualSignal.midMotion": "The same envelope for the middle group.",
  "VisualSignal.highMotion": "The same envelope for the high group.",
  "VisualSignal.beat": "A beat's strength on the frame it fires, otherwise 0. At most 3 a second, scaled by the reactivity gain, and 0 under Calm. It can exceed 1 under Lively.",
  "VisualSignal.drive": "The reactivity gain: 0 under Calm, 1 under Balanced, 1.6 under Lively. Scale motion terms that are not an envelope by it.",
  "VisualSignal.loudness": "Absolute loudness in 0..1, the rms in dBFS through a fixed window and eased. It tells a quiet master from a loud one, and stays live under Calm.",
  "VisualSignal.bassHit": "A transient envelope for the low group: near 0 between hits, near 1 on a clear hit. Not rate-capped, so use it for motion and small features, never large-area light. 0 under Calm, up to 1.6 under Lively.",
  "VisualSignal.midHit": "The same transient envelope for the middle group.",
  "VisualSignal.highHit": "The same transient envelope for the high group.",
  "VisualSignal.beatWeight": "How much a beat deserves to show: high for a loud, bass-led onset that stands out from the recent ones. It is held for a short span after `beat` fires, then reads 0. Rate-capped with `beat`.",
  "VisualSignal.surge": "A loudness jump on the frame it is detected, otherwise 0: a drop landing. Rare.",
  "VisualSignal.cut": "A loudness fall on the frame it is detected, otherwise 0: the music dropping away. Rare.",

  "VisPointer.x": "Horizontal position over the stage, 0 at the left edge to 1 at the right.",
  "VisPointer.y": "Vertical position over the stage, 0 at the top edge to 1 at the bottom.",
  "VisPointer.inside": "True while the pointer is over the stage.",

  "VisColors.ground": "The stage ground.",
  "VisColors.backing": "The ground under a cover-sized dot matrix.",
  "VisColors.ink": "The color to draw lines and text in so they read on the ground.",

  "VisContext.layout": "The stage and cover geometry. See the table below.",
  "VisContext.palette": "The cover palette, as in `frame.palette`.",
  "VisContext.cover": "The cover as an ImageBitmap, or null.",
  "VisContext.colors": "The stage colors.",
  "VisContext.light": "Whether the kind draws light: false for a dark-only kind in a light theme.",
  "VisContext.reactivity": "The user's reactivity level. The signal already reflects it; read it only to decide what to draw.",
  "VisContext.ambient": "Whether the kind draws behind the whole app.",
  "VisContext.reducedMotion": "True when the user asked for reduced motion. Hold still.",
  "VisContext.settings": "The current setting values, as in `frame.settings`.",

  "VisLayout.width": "The stage width.",
  "VisLayout.height": "The stage height.",
  "VisLayout.cover": "The cover's rect: left, top, width, height.",
  "VisLayout.radius": "The cover's corner radius.",
  "VisLayout.mask": "The rect the layer feathers off outside, or null to draw the whole stage.",
  "VisLayout.floor": "The top edge of the element the layer rests on, or null for none.",
  "VisLayout.hush": "Rects of text blocks the layer may soften behind, so labels stay readable.",
};
