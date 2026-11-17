/*
 * Runs one fixture on three hosts that differ only in headers: the released policy, the released policy
 * with connect-src 'self', and the policy with the CORS header added. The fixture fetches a JSON file,
 * loads a module script and a crossorigin image uploaded to a texture. The host log adds what each
 * request carried as its Origin header; an `absent` reading does not decide the probe, because the
 * webview may hide that header from the host.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { probeHostLog } from "../ipc";
import { awaitMessage, orAbort, waitMs } from "./transportStandIn";

// -- Type Imports --
import type { ProbeHost } from "../frames";
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const RUN_TIMEOUT_MS = 20_000;
const LOG_SETTLE_MS = 300;
// The host log keeps this many lines; a full buffer can hide repeats of identical lines.
const LOG_CAP = 200;
const HOSTS: { host: ProbeHost; expectOk: boolean; label: string }[] = [
  { host: "probe-ui0", expectOk: false, label: "released headers" },
  { host: "probe-ui0s", expectOk: false, label: "released, connect-src self" },
  { host: "probe-ui1", expectOk: true, label: "CORS header added" },
];
const WATCHED = ["/data.json", "/mod.js", "/mod.mjs", "/gen/pattern.png"];

interface Try {
  ok: boolean;
  /** The try could not run at all (no WebGL2 in the frame), which says nothing about the headers. */
  unavailable?: boolean;
  detail: string;
}

interface CorsResult {
  type: string;
  fetch: Try;
  module: Try;
  mjs?: Try;
  image: Try;
  upload: Try;
  violations: string[];
}

export type TryState = "ok" | "fail" | "unavailable";

export interface HostRow {
  host: string;
  expectOk: boolean;
  /** Null when the frame gave no result. */
  tries: { name: string; state: TryState }[] | null;
}

export interface CorsVerdict {
  state: "pass" | "fail" | "invalid";
  problems: string[];
}

/**
 * Invalid when a frame gave no result or a try could not run; otherwise fail where a host did the
 * opposite of its expectation, else pass.
 */
export function judgeCors(rows: readonly HostRow[]): CorsVerdict {
  const invalid: string[] = [];
  const mismatches: string[] = [];
  for (const row of rows) {
    if (!row.tries) {
      invalid.push(`${row.host} gave no result`);
      continue;
    }
    for (const t of row.tries) {
      if (t.state === "unavailable") invalid.push(`${row.host} ${t.name} could not run`);
      else if ((t.state === "ok") !== row.expectOk) mismatches.push(`${row.host} ${t.name} ${t.state === "ok" ? "succeeded" : "failed"}`);
    }
  }
  if (rows.length === 0) invalid.push("no host ran");
  if (invalid.length) return { state: "invalid", problems: invalid };
  return { state: mismatches.length ? "fail" : "pass", problems: mismatches };
}

/**
 * The lines `after` gained over `before`, given that the log keeps only its newest lines. When the
 * buffer was full and identical lines repeat, some new lines can be missed.
 */
export function newLines(before: readonly string[], after: readonly string[]): string[] {
  for (let skip = 0; skip <= before.length; skip++) {
    const overlap = before.length - skip;
    if (overlap > after.length) continue;
    let same = true;
    for (let i = 0; i < overlap; i++) {
      if (before[skip + i] !== after[i]) {
        same = false;
        break;
      }
    }
    if (same) return after.slice(overlap);
  }
  return [...after];
}

const LOG_LINE = /^GET (\S+) (\S+) context=\S+ .*origin=(\w+) -> (\d+)$/;

/** One short entry per watched request of a host: path, Origin class and status. */
function logEntries(lines: readonly string[], host: string): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = LOG_LINE.exec(line);
    if (m && m[1] === host && WATCHED.includes(m[2])) out.push(`${m[2]} origin=${m[3]} ${m[4]}`);
  }
  return out;
}

const word = (t: Try | undefined) => (t ? (t.ok ? "ok" : `${t.unavailable ? "unavailable" : "fail"} (${t.detail})`) : "n/a");

function stateOf(t: Try): TryState {
  return t.unavailable ? "unavailable" : t.ok ? "ok" : "fail";
}

/** The image row: a failed load fails it; a load that worked but could not be uploaded is judged by the upload. */
function imageState(result: CorsResult): TryState {
  if (!result.image.ok) return "fail";
  return stateOf(result.upload);
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const lines: string[] = [];
  const rows: HostRow[] = [];
  for (const { host, expectOk, label } of HOSTS) {
    if (ctx.signal.aborted) break;
    ctx.log(host);
    const before = await orAbort(probeHostLog(), ctx.signal);
    if (!before) break;
    const frame = await mountProbeFrame({
      host,
      file: "cors.html",
      parent: ctx.stages.subject.slot,
      signal: ctx.signal,
    });
    let result: CorsResult | null;
    try {
      result = await awaitMessage<CorsResult>(frame.port, "result", RUN_TIMEOUT_MS, ctx.signal, () =>
        frame.port.postMessage({ type: "run", mjs: host === "probe-ui1" }),
      );
    } finally {
      frame.unmount();
    }
    await waitMs(LOG_SETTLE_MS, ctx.signal);
    if (ctx.signal.aborted) break;
    const after = await orAbort(probeHostLog(), ctx.signal);
    if (!after) break;
    const seen = logEntries(newLines(before, after), host);
    const fullNote = before.length >= LOG_CAP ? " (the log was full, repeated lines may be missed)" : "";
    if (!result) {
      lines.push(`${host} (${label}): the frame gave no result in ${RUN_TIMEOUT_MS} ms`);
      rows.push({ host, expectOk, tries: null });
      continue;
    }
    const tries = [
      { name: "fetch", state: stateOf(result.fetch) },
      { name: "module", state: stateOf(result.module) },
      { name: "image upload", state: imageState(result) },
    ];
    if (host === "probe-ui1" && result.mjs) tries.push({ name: "mod.mjs", state: stateOf(result.mjs) });
    rows.push({ host, expectOk, tries });
    const violated = result.violations.length ? `; policy violations: ${[...new Set(result.violations)].join(", ")}` : "";
    lines.push(
      `${host} (${label}): fetch ${word(result.fetch)}, module ${word(result.module)}, image ${word(result.image)}, upload ${word(result.upload)}${result.mjs ? `, mod.mjs ${word(result.mjs)}` : ""}${violated}`,
    );
    lines.push(`${host} host log${fullNote}: ${seen.length ? seen.join(", ") : "no watched request logged"}`);
  }
  if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped", ...lines] };
  const verdict = judgeCors(rows);
  const origins = "an absent Origin reading does not decide the probe";
  const head =
    verdict.state === "pass"
      ? []
      : [`${verdict.state === "invalid" ? "cannot judge" : "differs from the pass line"}: ${verdict.problems.join("; ")}`];
  return { state: verdict.state, lines: [...head, ...lines, origins] };
}

export const probe: ProbeModule = {
  id: "P10",
  run,
  timeoutMs: 90_000,
};
