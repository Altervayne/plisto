/*
 * The probe catalog: the card text of every probe in page order, including the ones this page does not
 * run, which carry their reason. The page lists all of it whether or not a module exists for the entry.
 */

// -- Type Imports --
import type { CardResult, CatalogEntry, ProbeState } from "./types";

export const CATALOG: CatalogEntry[] = [
  {
    id: "P1",
    title: "Blend over an out-of-process frame",
    kind: "A+C",
    what:
      "A pattern drawn in a sandboxed frame and, for the offscreen-canvas shape, in a transferred canvas, in the stage's visualizer slot over the glow and aurora. 32 cases: screen, multiply, normal, soft-light x light, dark x WebGL, 2D x dip 1 and 0.5, each compared to the same pattern on a plain canvas. Controls: null, solid, sensitivity, negative.",
    pass: "Every case within 2/255 of the reference, with all four controls as stated. A failed control reads invalid, never pass.",
  },
  {
    id: "P2",
    title: "Transparency and color scheme",
    kind: "A+C",
    what:
      "An empty transparent frame over each stage in both themes, against no frame. A frame whose root asks for the dark scheme while its element does not is the mismatch control and should paint opaque.",
    pass: "No opaque backdrop: at most 2/255 against no frame, both themes.",
  },
  {
    id: "P3",
    title: "Process placement and recovery",
    kind: "A",
    what:
      "A frame answering pings every 100 ms next to a frame busy-looping for 10 s, and a variant with a spinning worker. Reads process ids, whether same-host frames share a process, pong latency, the page's longest frame gap, CPU, exit after unmount, and the guarded terminate.",
    pass: "Separate processes, the page keeps answering, and a remedy exists.",
  },
  {
    id: "P4",
    title: "Mount to first frame, memory",
    kind: "B",
    what:
      "Cold, warm and re-mount: frame insertion to its first drawn frame after compiling the real Lake and shared programs, salted per run. Reference: the same compile in a fresh main-document context. Working set and private bytes of the frame's process.",
    pass: "Under 300 ms warm, under 1 s cold (reported as a lower bound).",
  },
  {
    id: "P5",
    title: "rAF in a frame at opacity 0 and in the dip",
    kind: "A",
    what:
      "The frame counts its own animation callbacks per 250 ms at opacity 1, held at 0 for 5 s, and through a dip driven by the real curve. Optional: window minimized for 5 s.",
    pass: "Known behavior: the rate per phase is reported.",
  },
  {
    id: "P6",
    title: "Transport: credits, coalescing, cost",
    kind: "B",
    what:
      "A 20 s run of a stand-in transport: 1 KB ticks every display frame, a consumer throttled to 30 fps that acks, a synthetic beat every 0.5 s, and a second run with the frame blocked 40 ms per frame. Reads post cost over batches, outstanding ticks, beats sent against seen, round trip.",
    pass: "Outstanding ticks at most 2, no lost beat, under 0.1 ms per post.",
  },
  {
    id: "P8",
    title: "Offscreen canvas into the frame, bitmap stream",
    kind: "A",
    what:
      "A canvas in the slot hands its control to a frame over a port and the frame draws into it; the page then tries to read the placeholder back. Also a 1920 x 1080 ImageBitmap stream from the frame to the page.",
    pass: "Known: whether the transfer works, whether the placeholder is readable, and the stream's cost.",
  },
  {
    id: "P9",
    title: "Devtools reach the frame",
    kind: "C",
    what:
      "Inspect the page, pick the frame's context in the console, call probeHello(), and look for vis-pattern.js in Sources.",
    pass: "Known: Yes or No.",
  },
  {
    id: "P10",
    title: "CORS: fetch, module script, image",
    kind: "A",
    what:
      "One fixture on three hosts: today's headers, today's headers with connect-src 'self' only, and the added headers. Each tries fetch, a module script and a crossorigin image uploaded to a texture, and the host log reports the Origin each request carried.",
    pass: "The added-headers host succeeds everywhere; the self-only host fails exactly where the CORS header is the only difference; today's host fails all.",
  },
  {
    id: "P11",
    title: "Blob worker and WASM",
    kind: "A",
    what:
      "A worker from a blob URL and an inline WebAssembly module, in a frame on the UI policy and in a frame on the visualizer policy.",
    pass: "Known: the visualizer frame runs both, the UI frame refuses both.",
  },
  {
    id: "P12",
    title: "Meter cost at 1920 x 1080",
    kind: "B",
    what:
      "A stand-in meter on a frame canvas at 1920 x 1080 and 3840 x 2160 backing: 64 x 36 downsample, asynchronous readback, per-cell luminance, 600 frames each, timed over batches of 10.",
    pass: "Median under 0.3 ms per meter step.",
  },
  {
    id: "P13",
    title: "Lake port against built-in Lake",
    kind: "X",
    what: "A port of Lake running in a frame, compared with the built-in Lake.",
    pass: "Becomes the gate of the runtime's first build.",
    outOfV0: "Needs the renderer seam and the runtime, which change the renderer: on hold.",
  },
  {
    id: "P14a",
    title: "Waveform snapshot: emit cost and jitter",
    kind: "A",
    what:
      "Rust emits a synthetic 1 KB payload at 30 Hz for 10 s. Reads Rust-side time per emit and, per sequence number, the page's arrival interval minus the send interval.",
    pass: "Under 0.1 ms per emit on the sending side; arrival intervals reported.",
  },
  {
    id: "P14b",
    title: "Waveform snapshot: engine tap and audio-side cost",
    kind: "X",
    what: "Where the engine takes the post-equalizer mono mix and what that costs on the audio side.",
    pass: "Known.",
    outOfV0: "Needs the engine emit, which does not exist yet.",
  },
  {
    id: "P14c",
    title: "Waveform snapshot: stitching",
    kind: "X",
    what: "Whether consecutive snapshots join without an audible or visible seam.",
    pass: "Owner's ears and eyes.",
    outOfV0: "Needs the engine emit, which does not exist yet.",
  },
  {
    id: "P7c",
    title: "GPU loss: a shader-caused hang",
    kind: "X",
    what: "A shader that hangs the GPU, and whether the browser then blocks WebGL for the app's origin.",
    pass: "Stays a stated unknown.",
    outOfV0:
      "Not run: it can force a Windows display-driver reset that blanks every screen and disturbs other apps.",
  },
  {
    id: "P7a",
    title: "GPU loss: a frame loses its context",
    kind: "A",
    what:
      "The frame loses its own WebGL context on purpose. Two WebGL2 contexts in the main document must see no loss event.",
    pass: "Known behavior: the main document's contexts are untouched.",
  },
  {
    id: "P7b",
    title: "GPU loss: the GPU process ends",
    kind: "A",
    what:
      "Rust ends the GPU process up to three times and the page records what follows: a clean restart, a software renderer, or WebGL refused. Stops at the first outcome that is not a clean restart. Never part of Run all.",
    pass: "Known behavior: how far a GPU crash reaches.",
    manual: true,
    warning:
      "Crashes Plisto's GPU process up to three times. Worst case: every Plisto window goes blank or closes (the browser process ends), or drawing falls back to software for the rest of this session. Copy results first. If Plisto closes, its next launch, dev or installed (they share the app data folder), may ask 'Plisto closed unexpectedly': choose Start normally.",
  },
];

/** Whether Run all runs the entry: every A and B probe except a manual one. */
function inRunAll(entry: CatalogEntry): boolean {
  return entry.kind !== "X" && entry.kind !== "C" && !entry.manual;
}

/** The order Run all follows: P1 and P2 first, then the rest in catalog order. */
export function runAllOrder(catalog: readonly CatalogEntry[]): string[] {
  const ids = catalog.filter(inRunAll).map((e) => e.id);
  const first = ["P1", "P2"].filter((id) => ids.includes(id));
  return [...first, ...ids.filter((id) => !first.includes(id))];
}

/** The state a card shows: the entry and the module's existence decide it before any run does. */
export function cardState(entry: CatalogEntry, hasModule: boolean, result: CardResult | undefined): ProbeState {
  if (entry.outOfV0) return "not in V0";
  if (!hasModule) return "not built";
  return result?.state ?? "not run";
}

/**
 * Whether a card's Run button is off: out of this page, no module yet, running, or an unticked
 * acknowledgement. A manual entry always needs the tick, whatever its module says.
 */
export function runDisabled(
  entry: CatalogEntry,
  hasModule: boolean,
  moduleHasWarning: boolean,
  acknowledged: boolean,
  busy: boolean,
): boolean {
  if (entry.kind === "X" || !hasModule || busy) return true;
  return (!!entry.manual || moduleHasWarning) && !acknowledged;
}
