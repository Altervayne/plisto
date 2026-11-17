/*
 * The transparency probe: an empty frame in one stage against no frame in the other must leave the backdrop
 * untouched in both themes. An opaque frame proves the capture sees frame pixels, and a frame whose root asks
 * for the dark color scheme while its element does not is measured, not judged.
 */

// -- Local Imports --
import { alphaNote, diffRegions, ensureRunning, grabStable, mountPainted, settle } from "../stageCapture";

// -- Type Imports --
import type { DiffStats } from "../pixelDiff";
import type { ProbeContext, ProbeModule, ProbeOutcome, Theme } from "../types";

const THEMES: readonly Theme[] = ["light", "dark"];
const THRESHOLD = 2;
const NULL_LIMIT = 2;
const OPAQUE_FLOOR = 20;

export interface ThemeReadings {
  /** Both stages without a frame. */
  empty: DiffStats;
  /** An empty frame in the subject stage, then in the reference stage, against the other without one. */
  overSubject: DiffStats;
  overReference: DiffStats;
  /** An opaque frame in the subject stage. */
  solid: DiffStats;
  /** A frame whose root asks for the dark scheme, in the subject stage. */
  mismatch: DiffStats;
}

function maxOf(d: DiffStats): string {
  return d.valid ? String(d.max) : `unreadable (${d.reason})`;
}

/** The P2 outcome from one set of readings per theme. */
export function judgeP2(readings: Record<Theme, ThemeReadings>, captureNote: string): ProbeOutcome {
  const problems: string[] = [];
  const failures: string[] = [];
  const lines: string[] = [];
  for (const theme of THEMES) {
    const r = readings[theme];
    for (const [name, d] of [
      ["empty stages", r.empty],
      ["empty frame in subject", r.overSubject],
      ["empty frame in reference", r.overReference],
      ["opaque frame", r.solid],
    ] as const) {
      if (!d.valid) problems.push(`${theme}: ${name} could not be compared: ${d.reason}`);
    }
    if (r.empty.valid && r.empty.max > NULL_LIMIT) problems.push(`${theme}: the empty stages differ (max ${r.empty.max})`);
    if (r.solid.valid && r.solid.max <= OPAQUE_FLOOR) {
      problems.push(`${theme}: an opaque frame is not visible in the capture (max ${r.solid.max})`);
    }
    for (const [name, d] of [
      ["subject", r.overSubject],
      ["reference", r.overReference],
    ] as const) {
      if (d.valid && d.max > THRESHOLD) failures.push(`${theme}: an empty frame over the ${name} stage changes it (max ${d.max})`);
    }
    lines.push(
      `${theme} ${maxOf(r.overSubject)}/${maxOf(r.overReference)}; opaque control ${maxOf(r.solid)}; scheme mismatch ${
        r.mismatch.valid ? (r.mismatch.max > THRESHOLD ? "paints opaque" : "stays transparent") : "unreadable"
      } (max ${maxOf(r.mismatch)})`,
    );
  }
  if (problems.length) return { state: "invalid", lines: [...problems, captureNote] };
  if (failures.length) return { state: "fail", lines: [...failures, ...lines, captureNote] };
  return { state: "pass", lines: [`no opaque backdrop within ${THRESHOLD}/255 in both themes`, ...lines, captureNote] };
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const { stages, env, signal } = ctx;
  const { dpr } = env;
  const breaks = [...stages.subject.stackingBreaks(), ...stages.reference.stackingBreaks()];
  if (breaks.length) return { state: "invalid", lines: [`the stage is not faithful: ${breaks.join("; ")}`] };

  let note = "";
  let offGrid = false;
  const save = ctx.saveCaptures;
  const compare = async (): Promise<DiffStats> => {
    await settle(signal);
    const got = await grabStable(stages, dpr, signal, save);
    if (!got.ok) return { valid: false, reason: got.reason };
    offGrid = offGrid || got.rects.offGrid;
    if (!note) {
      const size =
        got.cap.plan.kind === "dip"
          ? "capture DIP-sized, edge band widened"
          : `capture scale ${got.cap.plan.scale.toFixed(2)}`;
      note = `${size}; ${alphaNote(got.cap)}`;
    }
    return diffRegions(got.cap, got.rects.reference, got.cap, got.rects.subject, []);
  };
  // The frame has answered a paint request before the capture, so an empty frame is not read before it renders.
  const withFrame = async (stage: "reference" | "subject", file: string): Promise<DiffStats> => {
    const frame = await mountPainted(stages[stage].slot, file, signal);
    try {
      return await compare();
    } finally {
      frame.unmount();
    }
  };

  const readings = {} as Record<Theme, ThemeReadings>;
  try {
    for (const theme of THEMES) {
      ensureRunning(signal);
      ctx.log(`${theme} theme`);
      ctx.setTheme(theme);
      for (const s of [stages.reference, stages.subject]) {
        s.setBlend("normal");
        s.setDip(1);
      }
      await settle(signal);
      const empty = await compare();
      const overSubject = await withFrame("subject", "vis-empty.html");
      const overReference = await withFrame("reference", "vis-empty.html");
      const solid = await withFrame("subject", "vis-solid.html");
      const mismatch = await withFrame("subject", "vis-scheme-dark.html");
      readings[theme] = { empty, overSubject, overReference, solid, mismatch };
    }
    const outcome = judgeP2(readings, note);
    if (offGrid) outcome.lines.push("a stage edge is off the device pixel grid");
    return outcome;
  } finally {
    for (const s of [stages.reference, stages.subject]) {
      s.setBlend("");
      s.setDip(1);
    }
    ctx.setTheme(env.theme);
  }
}

export const probe: ProbeModule = {
  id: "P2",
  timeoutMs: 60_000,
  run,
};
