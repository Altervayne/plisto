/*
 * Builds the checker's verdict for each kind from its raw run and prints it, as lines or as JSON. The exit
 * code lives here too: 0 when everything passes, 1 when a rule or a limit fails, 3 when the only finding is
 * flashing, which Plisto does not refuse. Usage and setup errors are 2, set by the command.
 */

// -- Local Imports --
import { FLASHES_PER_SEC_LIMIT, HANG_LIMIT_MS, SLOW_FRAME_LIMIT_MS, SLOW_SPAN_MS } from "../limits.js";
import { judgeRun } from "./judge.mjs";
import { listingText } from "./listing.mjs";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_FLASHING = 3;

const num = (v, digits = 1) => (v === null || v === undefined ? "n/a" : Number(v.toFixed(digits)));

/** The verdict for one kind: its manifest facts, its raw run and the judgement of the run. */
export function verdictFor(decl, raw) {
  const form = decl.shader !== null ? "shader" : "page";
  const kind = { id: decl.id, name: decl.name, source: decl.shader ?? decl.page, form };
  if (raw.error) {
    const { stage, message } = raw.error;
    const compile = { ok: false, stage, message, readyMs: raw.readyMs };
    return { ...kind, compile, pass: false, flashing: false };
  }
  const judged = judgeRun(raw);
  const failed = judged.hung || judged.slow;
  return {
    ...kind,
    compile: { ok: true, readyMs: raw.readyMs },
    run: judged,
    still: raw.stillPath ? { path: raw.stillPath } : { note: raw.stillError ?? "no still" },
    pass: !failed,
    flashing: judged.flashing || judged.red,
  };
}

/** The exit code for the verdicts: a failure wins over flashing, which alone has its own code. */
export function exitCodeFor(verdicts) {
  if (verdicts.some((v) => !v.pass)) return EXIT_FAILED;
  return verdicts.some((v) => v.flashing) ? EXIT_FLASHING : EXIT_OK;
}

/** The whole report for a plugin that passed the manifest check. */
export function buildReport(facts, listing, verdicts, extra) {
  const plugin = { id: facts.id, name: facts.name };
  const exitCode = exitCodeFor(verdicts);
  return { plugin, manifest: { ok: true }, listing, kinds: verdicts, ...extra, exitCode };
}

/** The report for a manifest that is refused. */
export function refusedReport(refusal) {
  return { manifest: { ok: false, refusal }, kinds: [], exitCode: EXIT_FAILED };
}

function kindLines(v, seconds) {
  const lines = [`Visualizer ${v.id} (${v.form}: ${v.source})`];
  if (!v.compile.ok) {
    lines.push(`  compile   FAILED at stage '${v.compile.stage}': ${v.compile.message}`);
    return lines;
  }
  const r = v.run;
  lines.push(`  compile   ready in ${num(v.compile.readyMs, 0)} ms`);
  const steps = `median step ${num(r.medianMs, 2)} ms, worst ${num(r.worstMs, 2)} ms`;
  lines.push(`  run       ${seconds} s, ${r.frames} frames, ${steps}`);
  if (r.judged && r.flashesPerSec === null) {
    lines.push("  flashing  ok: never over the limit (the meter reports only when it trips)");
  } else if (r.judged) {
    const flash = `${num(r.flashesPerSec)} flashes a second, ${num(r.redFlashesPerSec)} red`;
    const mark = r.flashing || r.red ? "WARNING" : "ok";
    lines.push(`  flashing  ${mark}: ${flash} (line: over ${FLASHES_PER_SEC_LIMIT}, or any red)`);
  } else {
    lines.push("  flashing  not judged: the kind registers no canvas, so Plisto cannot watch it either");
  }
  const span = `${SLOW_SPAN_MS / 1000} s`;
  const slow = `a median step over ${SLOW_FRAME_LIMIT_MS} ms for ${span} is slow`;
  lines.push(`  slow      ${r.slow ? "FAILED" : "ok"}: ${slow}`);
  const gap = `${num(r.longestGapMs, 0)} ms (limit ${HANG_LIMIT_MS} ms)`;
  lines.push(`  hang      ${r.hung ? "FAILED" : "ok"}: longest gap between frames ${gap}`);
  lines.push(`  still     ${v.still.path ?? `none (${v.still.note})`}`);
  return lines;
}

/** The report as text lines. */
export function formatReport(report, seconds) {
  if (!report.manifest.ok) return [`Manifest   REFUSED: ${report.manifest.refusal}`];
  const lines = [
    `Plugin     ${report.plugin.id ?? "(no id)"}`,
    `Manifest   ok: ${report.kinds.length} visualizer${report.kinds.length === 1 ? "" : "s"} checked`,
    `Listing    ${listingText(report.listing)}`,
  ];
  for (const v of report.kinds) lines.push("", ...kindLines(v, seconds));
  const failed = report.kinds.filter((x) => !x.pass).length;
  const flashing = report.kinds.filter((x) => x.flashing).length;
  lines.push("");
  if (failed > 0) lines.push(`FAILED: ${failed} of ${report.kinds.length} visualizers`);
  if (flashing > 0) {
    const past = `${flashing} of ${report.kinds.length} go past the flashing line`;
    lines.push(`WARNING: ${past}; see docs/photosensitivity.md`);
  }
  if (failed === 0 && flashing === 0) lines.push("PASSED");
  return lines;
}
