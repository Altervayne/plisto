/*
 * Types for `plistoVis`, the runtime every plugin visualizer frame loads as a global script. A kind
 * registers once with `shader`, `scene`, `candidate` or `raw`. Include this file in the project that
 * type-checks the plugin; it declares the global `plistoVis` and leaves everything else alone.
 */

declare namespace plistoVis {
  // -- Shared shapes --

  /** A rect in GL pixels: left, bottom, width, height. */
  type Rect = [number, number, number, number];
  /** A rect in CSS pixels with a top-left origin: left, top, width, height. */
  type VisRect = [number, number, number, number];
  /** An sRGB color in 0..1. */
  type VisRgb = [number, number, number];
  type VisSettingValue = boolean | number | string;

  /** The audio signal every frame carries. */
  interface VisualSignal {
    bands: Float32Array;
    rms: number;
    peak: number;
    flux: number;
    kick: number;
    bass: number;
    mid: number;
    high: number;
    level: number;
    swell: number;
    bassMotion: number;
    midMotion: number;
    highMotion: number;
    beat: number;
    drive: number;
    loudness: number;
    bassHit: number;
    midHit: number;
    highHit: number;
    beatWeight: number;
    surge: number;
    cut: number;
  }

  /** One frame's inputs. */
  interface Frame {
    t: number;
    dt: number;
    sig: VisualSignal;
    // Three sRGB colors in 0..1, flattened.
    palette: Float32Array;
    light: boolean;
    ambient: boolean;
    still: boolean;
    // Whether the track is playing.
    playing: boolean;
    // The smoothed 128-band spectrum, or null to fall back on the 24 bands.
    fine: number[] | null;
    // The cover's pixels, flipped for GL, or null when there are none.
    cover: ImageBitmap | null;
    mirrored: boolean;
    // The ground under a cover-sized dot matrix, as sRGB in 0..1.
    backing: [number, number, number];
    // The stage's own ground as sRGB in 0..1.
    ground: [number, number, number];
    // The track position over its duration in 0..1, or null when unknown.
    progress?: number | null;
  }

  /** The frame a runtime kind draws: the built-in kinds' frame, plus what only the feed knows. */
  interface VisFrame extends Frame {
    settings: Record<string, VisSettingValue>;
    rawBands: number[];
    // Beats fired since the last drawn frame.
    nBeats: number;
    // The playback position in seconds of the latest beat, or null before any.
    beatAt: number | null;
    // Bumps on a track change.
    trackSeq: number;
    // The pointer over the stage, normalized to 0..1, when the kind asks for it.
    pointer: VisPointer | null;
    wave: Float32Array | null;
    colors: VisColors;
  }

  interface VisPointer { x: number; y: number; inside: boolean }

  /** The stage colors a kind paints with besides the palette. */
  interface VisColors { ground: VisRgb; backing: VisRgb; ink: VisRgb }

  /** Where the stage and the cover sit, in CSS pixels relative to the frame's viewport. */
  interface VisLayout {
    width: number;
    height: number;
    cover: VisRect;
    radius: number;
    // The rect the layer feathers off outside; null draws the whole stage.
    mask: VisRect | null;
    // The top edge of the element the layer rests on, or null for none.
    floor: number | null;
    // The text blocks the layer may hush behind.
    hush: VisRect[];
  }

  /** The state that changes rarely: handed to `setup` and again when part of it changes. */
  interface VisContext {
    layout: VisLayout;
    palette: Float32Array;
    cover: ImageBitmap | null;
    colors: VisColors;
    // Whether the kind draws light: false for a dark-only kind in a light theme.
    light: boolean;
    reactivity: "calm" | "balanced" | "lively";
    ambient: boolean;
    reducedMotion: boolean;
    settings: Record<string, VisSettingValue>;
  }

  // -- The kit --

  /** The feedback a trail candidate applies to the previous frame. */
  interface Trail { decay: number; zoom: number; rot: number }

  /** One kind's look and draw. */
  interface Candidate {
    // A glow is light that maps to screen or multiply by theme; an image paints real color.
    mode: "glow" | "image";
    bloom: number;
    exposure: number;
    // The extra exposure ink needs on a light ground to read at the weight of light on a dark one.
    inkGain: number;
    trail: Trail | null;
    draw: (frame: Frame) => void;
    trailCenter?: () => [number, number];
    trailZoom?: (frame: Frame) => number;
    trailDecay?: (frame: Frame) => number;
    // The corner darkening ambient applies, 0..1; absent, the stage default.
    vignette?: number;
    dispose: () => void;
  }

  /** One program's name and sources. */
  interface ProgramSource { name: string; vs: string; fs: string }

  interface Program { handle: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> }

  interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

  /** Where the cover and the mask sit on the stage, in GL pixels. */
  interface Geometry {
    cover: Rect;
    radius: number;
    mask: Rect | null;
    floor: number | null;
    hush: Rect[];
  }

  interface Kit {
    gl: WebGL2RenderingContext;
    // The backing size in device pixels and the pixel ratio.
    size: { w: number; h: number; dpr: number };
    geo: Geometry;
    program: (src: ProgramSource) => Program;
    // The names of programs still compiling.
    pending: () => string[];
    uniform: (p: Program, name: string) => WebGLUniformLocation | null;
    set1: (p: Program, name: string, v: number) => void;
    set2: (p: Program, name: string, a: number, b: number) => void;
    set4: (p: Program, name: string, v: Rect) => void;
    seti: (p: Program, name: string, v: number) => void;
    bindTex: (p: Program, name: string, unit: number, tex: WebGLTexture) => void;
    setCommon: (p: Program, frame: Frame) => void;
    drawQuad: () => void;
    makeTarget: (w: number, h: number) => Target;
    freeTarget: (t: Target) => void;
    bindTarget: (t: Target | null) => void;
    // The target last bound, so a kind that draws into its own buffers can return to the scene.
    boundTarget: () => Target | null;
    dispose: () => void;
  }

  // -- Registration forms --

  interface ShaderSpec {
    source: string;
    mode?: "glow" | "image";
    bloom?: number;
    exposure?: number;
    inkGain?: number;
    vignette?: number;
  }

  interface ScenePass {
    name: string;
    // The whole fragment source; the vertex stage is the full-screen triangle.
    fs: string;
    // Keeps a pair of buffers and reads its previous output as `uPrev`.
    feedback?: boolean;
    // A pass with its own buffer sizes it at this share of the stage, 0..1.
    scale?: number;
    // Earlier passes this one samples, each bound as a sampler named after the pass.
    inputs?: string[];
    // "add" blends onto what the buffer holds; the default replaces it.
    blend?: "replace" | "add";
  }

  interface SceneSpec<S> {
    passes: ScenePass[];
    mode?: "glow" | "image";
    bloom?: number;
    exposure?: number;
    inkGain?: number;
    vignette?: number;
    trail?: Trail | null;
    // Beat rings for the fluid uniforms: life and rise in seconds, height per unit of beat.
    rings?: { life: number; rise: number; height: number };
    init?: (kit: Kit) => S;
    // Advances the state once per frame; the number it returns is the fluid flow.
    update?: (frame: VisFrame, state: S) => number | void;
    // Sets a pass's own uniforms while its program is in use.
    uniforms?: (pass: string, program: Program, kit: Kit, frame: VisFrame, state: S) => void;
    dispose?: (state: S, kit: Kit) => void;
  }

  interface CandidateOptions {
    // Programs the factory draws with, compiled together before it runs.
    programs?: ProgramSource[];
  }

  interface RawHandlers {
    // May return the canvas the kind draws on, for stills and the flash meter.
    setup?: (ctx: VisContext) => HTMLCanvasElement | void;
    frame: (frame: VisFrame) => void;
    resize?: (layout: VisLayout) => void;
    theme?: (ctx: VisContext) => void;
    settings?: (settings: VisContext["settings"]) => void;
    // Draws the still frame, or returns it as a bitmap; absent, `frame` draws it.
    still?: (frame: VisFrame) => void | ImageBitmap;
    dispose?: () => void;
  }

  interface StageMeter {
    // Call after each frame is drawn.
    frame: () => void;
    dispose: () => void;
  }

  // -- Helper shapes --

  interface BeatClock {
    clock: number;
    lastBeat: number;
    period: number;
    beatPos: number;
    pull: number;
    lock: number;
  }

  interface CosmicPunch { held: number; eased: number }

  interface CoverTexture {
    tex: WebGLTexture;
    sync: (bitmap: ImageBitmap) => boolean;
    dispose: () => void;
  }

  interface CyberBeatState { be: number; tgt: number; seed: number }

  interface Dots {
    begin: (p: Program, f: Frame) => void;
    draw: (count: number, glow: boolean) => void;
    floorY: () => number;
    dispose: () => void;
  }

  interface ReactivityProfile { gain: number; release: number }

  interface Rings {
    packed: Float32Array;
    step: (dt: number, beat: number) => void;
    clear: () => void;
  }

  // -- Registration --

  /** The visualizer api this runtime serves. */
  const version: 1;
  /** Registers a fragment shader kind. */
  function shader(spec: ShaderSpec): void;
  /** Registers a kind of one or more full-screen passes. */
  function scene<S>(spec: SceneSpec<S>): void;
  /** Registers a kind written as a factory over the kit, the way the built-in kinds are. */
  function candidate(factory: (kit: Kit) => Candidate, options?: CandidateOptions): void;
  /** Registers a kind that draws itself. */
  function raw(handlers: RawHandlers): void;
  /** Watches a canvas for flashing; the meter never changes what the kind draws. */
  function meter(canvas: HTMLCanvasElement): StageMeter;

  // -- Bridge --

  /** Calls a host method over the plugin bridge. */
  function call(method: string, args?: unknown): Promise<unknown>;
  const log: Record<"debug" | "info" | "warn" | "error", (text: unknown) => Promise<unknown>>;
  const storage: {
    get: (key: string, fallback?: unknown) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<unknown>;
    remove: (key: string) => Promise<unknown>;
    keys: (prefix?: string) => Promise<unknown>;
    clear: () => Promise<unknown>;
    usage: () => Promise<unknown>;
  };

  // -- Shader sources --

  const FS_VS: string;
  const PRELUDE: string;
  const HUSH: string;
  const HUSH_SLOTS: 2;
  const FLUID_PRELUDE: string;
  const COZY_PRELUDE: string;
  const SCENE_PRELUDE: string;
  const DOT_PRELUDE: string;
  const DOT_FS: string;
  const CYBER_KIT: string;
  const COSMIC_COMMON: string;
  /** The uniform a setting arrives in: its id with anything outside [A-Za-z0-9_] turned to `_`. */
  function settingUniform(id: string): string;

  // -- Helpers --

  const RING_SLOTS: 3;
  function createRings(life: number, rise: number, height: number): Rings;
  function setFluid(
    kit: Kit,
    p: Program,
    f: Frame,
    flow: number,
    rings: Float32Array | null,
    coverTex: WebGLTexture | null,
  ): void;
  function setScene(
    kit: Kit,
    p: Program,
    f: Frame,
    flow: number,
    rings: Float32Array | null,
    coverTex: WebGLTexture | null,
  ): void;
  function clamp01(v: number): number;
  function createRng(seed: number): () => number;
  function createDots(kit: Kit): Dots;
  function createCoverTexture(gl: WebGL2RenderingContext): CoverTexture;
  function createBeatClock(): BeatClock;
  function stepBeatClock(st: BeatClock, dt: number, beat: number, drive: number): void;
  function createCyberBeat(): CyberBeatState;
  function cyberBandMean(bands: ArrayLike<number>, lo: number, hi: number): number;
  function cyberBands(eased: Float32Array, sig: VisualSignal, gain: number, dt: number): Float32Array;
  function cyberBeat(
    st: CyberBeatState,
    sig: VisualSignal,
    gain: number,
    dt: number,
    rng: () => number,
  ): number;
  function cyberGain(sig: VisualSignal, playing: boolean): number;
  function createCosmicPunch(): CosmicPunch;
  function cosmicPunch(st: CosmicPunch, beat: number, dt: number): number;

  // -- Signal --

  const BAND_COUNT: 24;
  const FINE_BAND_COUNT: 128;
  const LEVEL_TAU: 0.9;
  const SWELL_TAU: 1.1;
  const MOTION_ATTACK_SECS: 0.05;
  const BEAT_MIN_GAP_SECS: 0.3;
  const BEAT_MAX_PER_SEC: 3;
  const REACTIVITY_PROFILES: Record<"calm" | "balanced" | "lively", ReactivityProfile>;
  function restingBands(): Float32Array;
  function restSignal(): VisualSignal;
  function admitBeat(fired: readonly number[], now: number): boolean;
  function easeEnvelope(prev: number, target: number, dt: number, tau: number): number;
  function motionEnvelope(prev: number, target: number, dt: number, release: number): number;
  function smoothBands(prev: number[], target: number[], attack: number, decay: number): number[];
}
