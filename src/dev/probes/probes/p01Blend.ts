/*
 * The blend probe: the same flat patterns drawn on a plain canvas (reference) and, in the other stage, in a
 * sandboxed frame or in a canvas whose control was transferred to a frame (subject), both in the visualizer
 * slot. A window capture is compared across blends, themes, drawing APIs and dip levels, behind four controls.
 * A comparison that cannot be trusted reads invalid, never pass. After a run, the owner can hold a case and paste
 * a screenshot of it to cross-check the capture against what the screen shows.
 */

// -- Local Imports --
import "../fixtures/pattern.js";
import { mountProbeFrame, type MountedFrame } from "../frames";
import { comparisonPlan, locateMarks, scaleRect } from "../pixelDiff";
import { watchSlot } from "../slotWatch";
import { MARK_CSS_PX } from "../hold";
import {
  alphaNote,
  diffPixelRects,
  diffRegions,
  ensureRunning,
  grabStable,
  mountPainted,
  request,
  settle,
} from "../stageCapture";

// -- Type Imports --
import type { Capture } from "../stageCapture";
import type { DiffStats, Rect, Rgba } from "../pixelDiff";
import type {
  ActionVerdict,
  CardAction,
  PastedImage,
  PastedLayout,
  ProbeContext,
  ProbeModule,
  ProbeOutcome,
  ProbeState,
  Theme,
} from "../types";

export const BLENDS = ["screen", "multiply", "normal", "soft-light"] as const;
export const THEMES: readonly Theme[] = ["light", "dark"];
export const APIS = ["webgl", "2d"] as const;
export const DIPS = [1, 0.5] as const;
type Api = (typeof APIS)[number];

const THRESHOLD = 2;
const NULL_LIMIT = 2;
const SOLID_LIMIT = 1;
const SENSITIVITY_FLOOR = 20;
// #3a6ea5, the opaque color of every solid control.
const SOLID_RGB = [58, 110, 165];
const FAILURES_LISTED = 6;
const NORMAL_FULL = /^normal\/[^/]+\/[^/]+\/dip1$/;
const NORMAL_DIPPED = /^normal\/[^/]+\/[^/]+\/dip0\.5$/;
// A case that could not draw is not a pixel result; the offscreen run stops at the first one.
const COULD_NOT_DRAW = "could not draw";

export interface CaseSpec {
  theme: Theme;
  blend: string;
  dip: number;
  api: Api;
}

export interface CaseResult {
  id: string;
  diff: DiffStats;
}

/** Every theme, blend, dip and drawing API once: the cases one subject runs. */
export function caseMatrix(): CaseSpec[] {
  const out: CaseSpec[] = [];
  for (const theme of THEMES) {
    for (const blend of BLENDS) {
      for (const dip of DIPS) {
        for (const api of APIS) out.push({ theme, blend, dip, api });
      }
    }
  }
  return out;
}

export function caseId(c: CaseSpec): string {
  return `${c.blend}/${c.theme}/${c.api}/dip${c.dip}`;
}

/** The pattern's patches that do not lie whole inside a slot of this size; none when the pattern fits. */
export function clippedPatches(patches: readonly Rect[], width: number, height: number): Rect[] {
  return patches.filter((p) => p.x < 0 || p.y < 0 || p.x + p.w > width || p.y + p.h > height);
}

function invalid(reason: string): DiffStats {
  return { valid: false, reason };
}

// ---- Verdict ----

export interface ControlReadings {
  nullLight: DiffStats;
  nullDark: DiffStats;
  /** An opaque frame background against an opaque canvas. */
  solid: DiffStats;
  /** An opaque frame canvas against the same drawn on the reference canvas, per drawing API. */
  solidWebgl: DiffStats;
  solid2d: DiffStats;
  sensitivity: DiffStats;
  negativeScreen: DiffStats;
  negativeMultiply: DiffStats;
}

export interface ControlVerdict {
  ok: boolean;
  lines: string[];
}

/** Checks one control reading; returns the problem text, or null when it holds. */
function controlProblem(name: string, diff: DiffStats, holds: (max: number) => boolean, why: string): string | null {
  if (!diff.valid) return `control ${name} could not be read: ${diff.reason}`;
  return holds(diff.max) ? null : `control ${name} failed (max ${diff.max}): ${why}`;
}

export function judgeControls(c: ControlReadings): ControlVerdict {
  const problems = [
    controlProblem("null light", c.nullLight, (m) => m <= NULL_LIMIT, "the two empty stages differ"),
    controlProblem("null dark", c.nullDark, (m) => m <= NULL_LIMIT, "the two empty stages differ"),
    controlProblem(
      "solid",
      c.solid,
      (m) => m <= SOLID_LIMIT,
      "the capture does not match an opaque frame to an opaque canvas, so it may lack the frame's pixels",
    ),
    controlProblem(
      "solid webgl canvas",
      c.solidWebgl,
      (m) => m <= SOLID_LIMIT,
      "the capture does not show the frame's WebGL canvas as the reference shows its own",
    ),
    controlProblem(
      "solid 2d canvas",
      c.solid2d,
      (m) => m <= SOLID_LIMIT,
      "the capture does not show the frame's 2D canvas as the reference shows its own",
    ),
    controlProblem(
      "sensitivity",
      c.sensitivity,
      (m) => m > SENSITIVITY_FLOOR,
      "screen and normal look alike, so the backdrop may be blank",
    ),
    controlProblem(
      "negative screen",
      c.negativeScreen,
      (m) => m > THRESHOLD,
      "an isolated frame matched the reference, so the diff cannot see a blend cut off from its backdrop",
    ),
    controlProblem(
      "negative multiply",
      c.negativeMultiply,
      (m) => m > THRESHOLD,
      "an isolated frame matched the reference, so the diff cannot see a blend cut off from its backdrop",
    ),
  ].filter((p): p is string => p !== null);
  if (problems.length) return { ok: false, lines: problems };
  const max = (d: DiffStats) => (d.valid ? d.max : -1);
  return {
    ok: true,
    lines: [
      `controls ok: null light ${max(c.nullLight)} dark ${max(c.nullDark)}; solid ${max(c.solid)} webgl ${max(c.solidWebgl)} 2d ${max(c.solid2d)}; sensitivity ${max(c.sensitivity)}; negative screen ${max(c.negativeScreen)} multiply ${max(c.negativeMultiply)}`,
    ],
  };
}

interface CaseSummary {
  total: number;
  within: number;
  failed: CaseResult[];
  unreadable: CaseResult[];
  worst: CaseResult | null;
}

function summarize(cases: readonly CaseResult[]): CaseSummary {
  const failed: CaseResult[] = [];
  const unreadable: CaseResult[] = [];
  let within = 0;
  let worst: CaseResult | null = null;
  for (const c of cases) {
    if (!c.diff.valid) {
      unreadable.push(c);
      continue;
    }
    if (c.diff.max > THRESHOLD) failed.push(c);
    else within++;
    const w = worst?.diff;
    if (!w || !w.valid || c.diff.max > w.max || (c.diff.max === w.max && c.diff.over > w.over)) worst = c;
  }
  return { total: cases.length, within, failed, unreadable, worst };
}

function numbersText(c: CaseResult): string {
  return c.diff.valid ? `max ${c.diff.max} over>${THRESHOLD} ${c.diff.over} p99.9 ${c.diff.p999}` : `invalid (${c.diff.reason})`;
}

export type OffscreenReport =
  | { available: true; cases: CaseResult[]; /** Why the remaining cases were not run, when they were not. */ stopped?: string }
  | { available: false; reason: string };

export interface P1Input {
  controls: ControlReadings;
  frame: CaseResult[];
  offscreen: OffscreenReport;
  captureNote: string;
  /** Cases one subject must have run. */
  expected: number;
}

function offscreenLine(report: OffscreenReport): string {
  if (!report.available) return `offscreen canvas: n/a (${report.reason})`;
  const s = summarize(report.cases);
  const worst = s.worst ? `; worst ${s.worst.id} ${numbersText(s.worst)}` : "";
  const bad = s.unreadable.length ? `; ${s.unreadable.length} unreadable` : "";
  const cut = report.stopped
    ? `; ${s.total} of ${caseMatrix().length} ran, the rest n/a (${report.stopped})`
    : "";
  return `offscreen canvas: ${s.within}/${s.total} within ${THRESHOLD}/255${worst}${bad}${cut}`;
}

/** The P1 outcome. Controls decide first: a failed control makes the whole probe invalid. */
export function judgeP1(input: P1Input): ProbeOutcome {
  const controls = judgeControls(input.controls);
  if (!controls.ok) return { state: "invalid", lines: controls.lines };
  const s = summarize(input.frame);
  const tail = [input.captureNote, ...controls.lines, offscreenLine(input.offscreen)];
  if (s.total !== input.expected) {
    return { state: "invalid", lines: [`${s.total} of ${input.expected} frame cases ran`, ...tail] };
  }
  const named = s.failed.slice(0, FAILURES_LISTED).map((c) => `${c.id} ${numbersText(c)}`);
  const more = s.failed.length > named.length ? [`and ${s.failed.length - named.length} more`] : [];
  const failedLines = s.failed.length
    ? [`${s.failed.length}/${s.total} frame cases beyond ${THRESHOLD}/255`, ...named, ...more]
    : [];
  // A normal blend at full opacity is the frame's own pixels over the backdrop, which the solid controls prove
  // the capture shows: a miss there is the capture, not the blend. At half opacity it is an opacity result.
  const normalMisses = s.failed.filter((c) => NORMAL_FULL.test(c.id));
  const opacityMisses = s.failed.filter((c) => NORMAL_DIPPED.test(c.id));
  const opacityLines = opacityMisses.length
    ? [`normal at dip 0.5 fails (${opacityMisses.map((c) => c.id).join(", ")}): an opacity result, not a blend-mode result`]
    : [];
  if (normalMisses.length) {
    const ids = normalMisses.slice(0, FAILURES_LISTED).map((c) => c.id).join(", ");
    return {
      state: "invalid",
      lines: [
        `the capture does not show the frame's canvas as the reference shows its own: normal fails (${ids})`,
        ...failedLines,
        ...opacityLines,
        ...tail,
      ],
    };
  }
  if (s.unreadable.length) {
    const unreadable = s.unreadable.slice(0, FAILURES_LISTED).map((c) => `${c.id} ${numbersText(c)}`);
    return {
      state: "invalid",
      lines: [
        `${s.unreadable.length} frame cases could not be compared`,
        ...unreadable,
        ...failedLines,
        ...opacityLines,
        ...tail,
      ],
    };
  }
  if (s.failed.length) return { state: "fail", lines: [...failedLines, ...opacityLines, ...tail] };
  const worst = s.worst ? `; worst ${s.worst.id} ${numbersText(s.worst)}` : "";
  return { state: "pass", lines: [`${s.within}/${s.total} frame cases within ${THRESHOLD}/255${worst}`, ...tail] };
}

// ---- Pasted screenshot ----

// Antialiased marks read their size low by up to about 10 percent, so the marks' scale only tells a device-size
// screenshot from another size; geometry comes from the page's pixel ratio and the marks' outer edges.
const MARK_SCALE_LOW = 0.85;
const MARK_SCALE_HIGH = 1.05;
const REGION_TOLERANCE = 0.03;
const REGISTRATION_SLACK_PX = 2;
const SCALE_GATE = `marks scale ${MARK_SCALE_LOW} to ${MARK_SCALE_HIGH} of dpr`;

/** Compares the two stages of a pasted screenshot located by its registration marks. */
export function crossCheckPasted(img: Rgba, dpr: number, layout: PastedLayout, patches: readonly Rect[]): DiffStats {
  const found = locateMarks(img, MARK_CSS_PX);
  if (!found) return invalid("registration marks not found");
  const ratio = found.scale / dpr;
  if (ratio < MARK_SCALE_LOW || ratio > MARK_SCALE_HIGH) {
    return invalid(`marks read scale ${found.scale.toFixed(2)}, the screenshot is not at device size ${dpr}`);
  }
  const span = found.region.w / (layout.region.w * dpr);
  if (Math.abs(span - 1) > REGION_TOLERANCE) return invalid("the marked region is not at device size");
  const at = (r: Rect): Rect => {
    const s = scaleRect(r, dpr);
    return { x: found.region.x + s.x, y: found.region.y + s.y, w: s.w, h: s.h };
  };
  const margin = comparisonPlan(dpr * 1000, 1000, dpr).margin + REGISTRATION_SLACK_PX;
  return diffPixelRects(img, at(layout.reference), img, at(layout.subject), patches, dpr, margin, THRESHOLD);
}

export interface Reconciled {
  state: ProbeState;
  note: string;
}

/**
 * Sets a pasted screenshot against the run's state. The screenshot shows what the screen shows; the capture is
 * what the probe measured. A screenshot beyond 2/255 against a capture pass means the capture is not showing
 * what the screen shows, so the run becomes invalid. A screenshot never upgrades a run: a fail or invalid stays.
 */
export function reconcile(state: ProbeState, diff: DiffStats): Reconciled {
  if (!diff.valid) return { state, note: "the run's state is unchanged" };
  const within = diff.max <= THRESHOLD;
  if (state === "pass" && !within) {
    return {
      state: "invalid",
      note: "RUN INVALID: the screenshot contradicts the capture pass, so the capture is not showing what the screen shows",
    };
  }
  if (state === "pass") return { state, note: "agrees with the capture pass" };
  if (state === "fail" || state === "invalid") {
    return { state, note: `the run stays ${state}; a screenshot never upgrades it` };
  }
  return { state, note: "no capture verdict to compare with" };
}

/** The card line for one pasted screenshot of the case held when it arrived. */
export function pasteLine(label: string, diff: DiffStats, state: ProbeState = "not run"): string {
  const gate = `gate: ${SCALE_GATE}`;
  const note = reconcile(state, diff).note;
  if (!diff.valid) return `${label}: pasted screenshot could not be compared: ${diff.reason} (${gate}; ${note})`;
  const verdict = diff.max <= THRESHOLD ? "within" : "beyond";
  return `${label}: pasted screenshot ${verdict} ${THRESHOLD}/255, max ${diff.max} over>${THRESHOLD} ${diff.over} p99.9 ${diff.p999} (${gate}; ${note})`;
}

/** What the run knows, shared with its hold actions: the capture verdict, once there is one. */
export interface RunRecord {
  state: ProbeState;
}

export interface HeldCase {
  id: string;
  spec: CaseSpec;
}

/** The two cases the owner can hold: the app's usual blend for each theme, on the WebGL path. */
export function heldCases(): HeldCase[] {
  return [
    { id: "hold-screen-dark", spec: { theme: "dark", blend: "screen", dip: 1, api: "webgl" } },
    { id: "hold-multiply-light", spec: { theme: "light", blend: "multiply", dip: 1, api: "webgl" } },
  ];
}

export interface HeldSetup {
  patches: Rect[];
  release(): void;
}

/** The failing frame case with the largest difference, or null when none fails. */
export function worstFailure(cases: readonly CaseResult[]): CaseSpec | null {
  const worst = summarize(cases).worst;
  if (!worst || !worst.diff.valid || worst.diff.max <= THRESHOLD) return null;
  return caseMatrix().find((c) => caseId(c) === worst.id) ?? null;
}

/**
 * One card action per held case: the two fixed ones, and the worst failing case when there is one. `prepare` puts
 * the case on the stages and returns how to undo it. A paste is judged against `record.state` as it stands then,
 * and a demotion sticks for the pastes after it.
 */
export function holdActions(
  prepare: (ctx: ProbeContext, spec: CaseSpec) => Promise<HeldSetup>,
  record: RunRecord,
  worst: CaseSpec | null = null,
): CardAction[] {
  const held = heldCases();
  if (worst && !held.some((h) => caseId(h.spec) === caseId(worst))) held.push({ id: "hold-worst", spec: worst });
  return held.map(({ id, spec }) => {
    const label = `Hold for screenshot: ${caseId(spec)}`;
    return {
      id,
      label,
      async run(ctx): Promise<ActionVerdict | undefined> {
        const held = await prepare(ctx, spec);
        // A demotion reaches the card with the paste, and is returned again when the hold ends (the rule is idempotent).
        let verdict: ActionVerdict | undefined;
        try {
          await ctx.hold({
            label: caseId(spec),
            onPaste: async (p: PastedImage) => {
              const diff = crossCheckPasted(p.image, p.dpr, p.layout, held.patches);
              const line = pasteLine(caseId(spec), diff, record.state);
              const next = reconcile(record.state, diff).state;
              const demoted = next !== record.state;
              if (demoted) verdict = { state: next };
              record.state = next;
              return demoted ? { line, verdict: { state: next } } : line;
            },
          });
        } finally {
          held.release();
        }
        return verdict;
      },
    };
  });
}

// ---- Layers ----

interface Layer {
  /** Shows `api` and draws the pattern; false when it could not draw. */
  show(api: Api): Promise<boolean>;
  dispose(): void;
}

function patternSize(): { width: number; height: number } {
  return globalThis.probePattern.size();
}

function sizeCanvas(canvas: HTMLCanvasElement, scale: number): void {
  const size = patternSize();
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
}

function patternCanvas(slot: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;left:0;top:0;display:none";
  slot.appendChild(canvas);
  return canvas;
}

function placeFrame(el: HTMLIFrameElement, small: boolean): void {
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.top = "0";
  el.style.border = "0";
  el.style.width = small ? "1px" : "100%";
  el.style.height = small ? "1px" : "100%";
}

function showOnly(canvases: Record<Api, HTMLCanvasElement>, api: Api): HTMLCanvasElement {
  for (const key of APIS) canvases[key].style.display = "none";
  const shown = canvases[api];
  shown.style.display = "block";
  return shown;
}

/** The reference: the pattern drawn on canvases in the page. */
function canvasLayer(slot: HTMLElement, dpr: number): Layer {
  const canvases: Record<Api, HTMLCanvasElement> = { webgl: patternCanvas(slot), "2d": patternCanvas(slot) };
  for (const key of APIS) sizeCanvas(canvases[key], dpr);
  return {
    async show(api) {
      const canvas = showOnly(canvases, api);
      const ctx = api === "webgl" ? globalThis.probePattern.drawWebGL(canvas, dpr) : globalThis.probePattern.draw2D(canvas, dpr);
      return ctx !== null;
    },
    dispose() {
      for (const key of APIS) canvases[key].remove();
    },
  };
}

/** The subject: a frame that fills the slot and draws with the named API on `show`. */
async function frameLayer(
  slot: HTMLElement,
  signal: AbortSignal,
  dpr: number,
  file = "vis-pattern.html",
): Promise<Layer> {
  const frame = await mountProbeFrame({ host: "probe-vis", file, parent: slot, signal });
  placeFrame(frame.el, false);
  return {
    async show(api) {
      const answer = await request(frame.port, { type: "show", api, scale: dpr }, "shown", signal);
      return answer.ok === true;
    },
    dispose: () => frame.unmount(),
  };
}

export type OffscreenSetup = { ok: true; layer: Layer } | { ok: false; reason: string };

/** The subject as an offscreen-canvas shape: canvases in the slot whose control a frame draws into. */
async function offscreenLayer(slot: HTMLElement, signal: AbortSignal, dpr: number): Promise<OffscreenSetup> {
  if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
    return { ok: false, reason: "transferControlToOffscreen is not available" };
  }
  const canvases: Record<Api, HTMLCanvasElement> = { webgl: patternCanvas(slot), "2d": patternCanvas(slot) };
  let frame: MountedFrame | null = null;
  const dispose = () => {
    for (const key of APIS) canvases[key].remove();
    frame?.unmount();
  };
  try {
    frame = await mountProbeFrame({ host: "probe-vis", file: "vis-placeholder.html", parent: slot, signal });
    placeFrame(frame.el, true);
    for (const api of APIS) {
      sizeCanvas(canvases[api], dpr);
      const offscreen = canvases[api].transferControlToOffscreen();
      await request(frame.port, { type: "canvas", api, canvas: offscreen }, "received", signal, [offscreen]);
    }
  } catch (e) {
    dispose();
    if (signal.aborted) throw e;
    return { ok: false, reason: `no offscreen frame: ${e instanceof Error ? e.message : String(e)}` };
  }
  const port = frame.port;
  return {
    ok: true,
    layer: {
      async show(api) {
        showOnly(canvases, api);
        const answer = await request(port, { type: "draw", api, scale: dpr }, "drawn", signal);
        return answer.ok === true;
      },
      dispose,
    },
  };
}

/** A canvas filling the slot with one flat color drawn through `api`, for the solid controls. */
function solidCanvas(slot: HTMLElement, dpr: number, api: Api): HTMLCanvasElement {
  const rect = slot.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%";
  if (api === "webgl") {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (gl) {
      gl.clearColor(SOLID_RGB[0] / 255, SOLID_RGB[1] / 255, SOLID_RGB[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  } else {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = `rgb(${SOLID_RGB.join(",")})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
  slot.appendChild(canvas);
  return canvas;
}

// ---- Run ----

function captureNote(c: Capture): string {
  const alpha = alphaNote(c);
  if (c.plan.kind === "device") return `capture device-sized (scale ${c.plan.scale.toFixed(2)}); ${alpha}`;
  if (c.plan.kind === "dip") return `capture DIP-sized (scale ${c.plan.scale.toFixed(2)}, edge band widened); ${alpha}`;
  return `capture scale ${c.plan.scale.toFixed(3)} is neither device nor DIP; ${alpha}`;
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const { stages, env, signal } = ctx;
  const { dpr } = env;
  const save = ctx.saveCaptures;
  // The screenshot route exists from the start, whatever the run does after this.
  const record: RunRecord = { state: "not run" };
  ctx.offerActions(holdActions(prepareHeld, record));
  const breaks = [...stages.subject.stackingBreaks(), ...stages.reference.stackingBreaks()];
  if (breaks.length) return { state: "invalid", lines: [`the stage is not faithful: ${breaks.join("; ")}`] };

  const both = [stages.reference, stages.subject];
  const patches: Rect[] = globalThis.probePattern.patches().map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
  const slotRect = stages.reference.slot.getBoundingClientRect();
  if (clippedPatches(patches, slotRect.width, slotRect.height).length) {
    return { state: "invalid", lines: ["the pattern does not fit the slot"] };
  }
  const layers: Layer[] = [];
  let theme = env.theme;
  let note = "";
  let offGrid = false;

  const useTheme = async (next: Theme) => {
    if (next === theme) return;
    theme = next;
    ctx.setTheme(next);
    await settle(signal);
  };
  const configure = (blend: string, dip: number) => {
    for (const s of both) {
      s.setBlend(blend);
      s.setDip(dip);
    }
  };
  const grab = async () => {
    const got = await grabStable(stages, dpr, signal, save);
    if (got.ok) {
      offGrid = offGrid || got.rects.offGrid;
      if (!note) note = captureNote(got.cap);
    }
    return got;
  };
  const compare = async (shown: Rect[]): Promise<DiffStats> => {
    const got = await grab();
    return got.ok ? diffRegions(got.cap, got.rects.reference, got.cap, got.rects.subject, shown) : invalid(got.reason);
  };

  const runCase = async (spec: CaseSpec, reference: Layer, subject: Layer): Promise<CaseResult> => {
    await useTheme(spec.theme);
    configure(spec.blend, spec.dip);
    const okReference = await reference.show(spec.api);
    const okSubject = await subject.show(spec.api);
    if (!okReference || !okSubject) {
      return { id: caseId(spec), diff: invalid(`${okReference ? "subject" : "reference"} ${COULD_NOT_DRAW} ${spec.api}`) };
    }
    await settle(signal);
    return { id: caseId(spec), diff: await compare(patches) };
  };

  try {
    // Controls first. Null: both stages empty, in each theme.
    const nulls: Record<Theme, DiffStats> = { light: invalid("not run"), dark: invalid("not run") };
    for (const t of THEMES) {
      ctx.log(`null control, ${t}`);
      await useTheme(t);
      configure("normal", 1);
      await settle(signal);
      nulls[t] = await compare([]);
    }

    // Solid: an opaque frame background against an opaque canvas, then an opaque frame canvas per drawing API
    // against the same color drawn on a reference canvas through the same API.
    await useTheme("dark");
    configure("normal", 1);
    ctx.log("solid control, frame background");
    let solid: DiffStats;
    let solidRef: HTMLCanvasElement | null = null;
    let solidFrame: MountedFrame | null = null;
    try {
      solidRef = solidCanvas(stages.reference.slot, dpr, "2d");
      solidFrame = await mountPainted(stages.subject.slot, "vis-solid.html", signal);
      await settle(signal);
      solid = await compare([]);
    } finally {
      solidRef?.remove();
      solidFrame?.unmount();
    }
    const solidCanvasReading = async (api: Api): Promise<DiffStats> => {
      ctx.log(`solid control, frame ${api} canvas`);
      let ref: HTMLCanvasElement | null = null;
      let layer: Layer | null = null;
      try {
        ref = solidCanvas(stages.reference.slot, dpr, api);
        layer = await frameLayer(stages.subject.slot, signal, dpr, "vis-solid-canvas.html");
        if (!(await layer.show(api))) return invalid(`the frame ${COULD_NOT_DRAW} ${api}`);
        await settle(signal);
        return await compare([]);
      } finally {
        ref?.remove();
        layer?.dispose();
      }
    };
    const solidWebgl = await solidCanvasReading("webgl");
    const solid2d = await solidCanvasReading("2d");

    // Sensitivity: on the reference, screen must differ from normal.
    ctx.log("sensitivity control");
    const reference = canvasLayer(stages.reference.slot, dpr);
    layers.push(reference);
    await reference.show("webgl");
    stages.reference.setBlend("normal");
    await settle(signal);
    const plain = await grab();
    stages.reference.setBlend("screen");
    await settle(signal);
    const screened = await grab();
    const sensitivity =
      plain.ok && screened.ok
        ? diffRegions(plain.cap, plain.rects.reference, screened.cap, screened.rects.reference, patches)
        : invalid("the stages moved during the capture");

    // Negative: an isolated frame must not match the reference.
    const subject = await frameLayer(stages.subject.slot, signal, dpr);
    layers.push(subject);
    const negative = async (blend: string, t: Theme) => {
      ctx.log(`negative control, ${blend}`);
      await useTheme(t);
      configure(blend, 1);
      await reference.show("webgl");
      await subject.show("webgl");
      stages.subject.setIsolated(true);
      try {
        await settle(signal);
        return await compare(patches);
      } finally {
        stages.subject.setIsolated(false);
      }
    };
    const negativeScreen = await negative("screen", "dark");
    const negativeMultiply = await negative("multiply", "light");

    const controls: ControlReadings = {
      nullLight: nulls.light,
      nullDark: nulls.dark,
      solid,
      solidWebgl,
      solid2d,
      sensitivity,
      negativeScreen,
      negativeMultiply,
    };
    const expected = caseMatrix().length;
    if (!judgeControls(controls).ok) {
      const stopped = judgeP1({ controls, frame: [], offscreen: { available: false, reason: "not run" }, captureNote: note, expected });
      record.state = stopped.state;
      return stopped;
    }

    const matrix = caseMatrix();
    const frame: CaseResult[] = [];
    for (const spec of matrix) {
      ensureRunning(signal);
      ctx.log(`frame case ${frame.length + 1}/${matrix.length}: ${caseId(spec)}`);
      frame.push(await runCase(spec, reference, subject));
    }
    subject.dispose();
    layers.splice(layers.indexOf(subject), 1);

    let offscreen: OffscreenReport;
    const watch = watchSlot(stages.subject.slot);
    try {
      const setup = await offscreenLayer(stages.subject.slot, signal, dpr);
      if (!setup.ok) {
        offscreen = { available: false, reason: setup.reason };
      } else {
        layers.push(setup.layer);
        const cases: CaseResult[] = [];
        let stopped: string | undefined;
        for (const spec of matrix) {
          ensureRunning(signal);
          ctx.log(`offscreen case ${cases.length + 1}/${matrix.length}: ${caseId(spec)}`);
          try {
            const result = await runCase(spec, reference, setup.layer);
            cases.push(result);
            if (!result.diff.valid && result.diff.reason.includes(COULD_NOT_DRAW)) stopped = result.diff.reason;
          } catch (e) {
            if (signal.aborted) throw e;
            const reason = e instanceof Error ? e.message : String(e);
            cases.push({ id: caseId(spec), diff: invalid(reason) });
            stopped = reason;
          }
          if (stopped) break;
        }
        offscreen = { available: true, cases, stopped };
      }
    } finally {
      watch.stop();
    }

    const outcome = judgeP1({ controls, frame, offscreen, captureNote: note, expected });
    if (watch.leftView) {
      outcome.state = "invalid";
      outcome.lines.unshift(watch.note);
    }
    if (offGrid) outcome.lines.push("a stage edge is off the device pixel grid");
    record.state = outcome.state;
    ctx.offerActions(holdActions(prepareHeld, record, worstFailure(frame)));
    return outcome;
  } finally {
    for (const l of layers) l.dispose();
    for (const s of both) {
      s.setIsolated(false);
      s.setBlend("");
      s.setDip(1);
    }
    ctx.setTheme(env.theme);
  }
}

/** Puts one case on the stages as the run did, with the iframe as subject, and returns how to take it down. */
async function prepareHeld(ctx: ProbeContext, spec: CaseSpec): Promise<HeldSetup> {
  const { stages, env, signal } = ctx;
  const both = [stages.reference, stages.subject];
  const layers: Layer[] = [];
  const release = () => {
    for (const l of layers) l.dispose();
    for (const s of both) {
      s.setBlend("");
      s.setDip(1);
    }
    ctx.setTheme(env.theme);
  };
  try {
    ctx.setTheme(spec.theme);
    for (const s of both) {
      s.setBlend(spec.blend);
      s.setDip(spec.dip);
    }
    const reference = canvasLayer(stages.reference.slot, env.dpr);
    layers.push(reference);
    layers.push(await frameLayer(stages.subject.slot, signal, env.dpr));
    for (const l of layers) await l.show(spec.api);
    await settle(signal);
  } catch (e) {
    release();
    throw e;
  }
  return { patches: globalThis.probePattern.patches().map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })), release };
}

export const probe: ProbeModule = {
  id: "P1",
  // 73 captures: 32 frame cases, 32 offscreen cases and 9 for the controls (2 null, 3 solid, 2 sensitivity,
  // 2 negative). At up to 3 s each (frame round trip, settle, capture) that is 219 s; about ten frame mounts
  // and a retake of a capture whose stages moved take the rest.
  timeoutMs: 300_000,
  run,
};
