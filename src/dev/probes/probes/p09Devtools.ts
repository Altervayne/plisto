/*
 * The devtools probe: whether the developer tools reach a visualizer frame. The frame stays mounted while
 * the owner opens Inspect, picks the frame's context in the Console, calls probeHello() and looks for the
 * frame's script in Sources, then answers Yes or No on the card. Stop or the deadline unmounts the frame
 * and leaves no reading.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";

// -- Type Imports --
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const QUESTION =
  "Right-click this page and choose Inspect. In the Console, pick the probe-vis.invalid context in the context " +
  "picker and run probeHello(): it should answer 'probe frame on probe-vis.invalid'. In Sources, look for " +
  "vis-pattern.js under probe-vis.invalid. Close devtools. Did both work?";

const STEPS =
  "Console: pick probe-vis.invalid, run probeHello(); Sources: look for vis-pattern.js";

/** The reading an owner's answer gives: both answers are known results, so neither is a failure. */
export function answerOutcome(answer: "yes" | "no" | null): ProbeOutcome {
  if (answer === null) return { state: "invalid", lines: ["no answer from the owner"] };
  const reach = answer === "yes" ? "devtools reach the frame" : "devtools do not reach the frame";
  return { state: "measured", lines: [STEPS, `owner answered ${answer}: ${reach}`] };
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  let frame;
  try {
    frame = await mountProbeFrame({
      host: "probe-vis",
      file: "vis-pattern.html",
      parent: ctx.stages.subject.slot,
      width: "100%",
      height: "100%",
      borderless: true,
      signal: ctx.signal,
    });
  } catch (e) {
    return { state: "invalid", lines: [`frame did not mount: ${e instanceof Error ? e.message : String(e)}`] };
  }
  try {
    return answerOutcome(await ctx.askYesNo(QUESTION));
  } finally {
    frame.unmount();
  }
}

export const probe: ProbeModule = {
  id: "P9",
  // A person works through devtools.
  timeoutMs: 600_000,
  run,
};
