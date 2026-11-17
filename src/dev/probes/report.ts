/*
 * The plain-text report "Copy results" produces: a header, then one line per probe. ASCII and LF only,
 * and any filesystem path in a result line is replaced, so the text can be pasted anywhere as it is.
 */

// -- Local Imports --
import { cardState } from "./catalog";

// -- Type Imports --
import type { CatalogEntry, CardResult, ProbeState } from "./types";

export interface ReportHeader {
  version: string;
  webview2: string;
  dpr: number;
  displayHz: number | null;
  gl: string;
  theme: string;
}

const LABEL: Record<ProbeState, string> = {
  pass: "PASS",
  fail: "FAIL",
  measured: "MEASURED",
  invalid: "INVALID",
  owner: "OWNER",
  "not run": "NOT RUN",
  running: "RUNNING",
  "not built": "NOT BUILT",
  "not in V0": "NOT IN V0",
  "timed out": "TIMED OUT",
  stopped: "STOPPED",
};

// A drive path or a home-folder path, up to the next space or separator of the line.
// The drive letter needs a non-word character before it and no second slash after, so the scheme of a
// URL ("https://") is never taken for a drive.
const PATH = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?!\/)[^\s;,"']*|\/(?:Users|home)\/[^\s;,"']*/g;

/** Text safe for the report: paths replaced, line breaks folded to spaces, non-ASCII replaced by '?'. */
export function clean(text: string): string {
  return text
    .replace(PATH, "<path>")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
}

/** One probe's line: its id, state and joined result lines (or the reason a card runs nothing). */
function line(
  entry: CatalogEntry,
  hasModule: boolean,
  result: CardResult | undefined,
  idWidth: number,
  stateWidth: number,
): string {
  const state = cardState(entry, hasModule, result);
  const detail = entry.outOfV0 ? [entry.outOfV0] : (result?.lines ?? []);
  const head = `${entry.id.padEnd(idWidth)} ${LABEL[state].padEnd(stateWidth)} `;
  return clean(`${head}${detail.join("; ")}`).trimEnd();
}

/** The whole report: title, header line, one line per catalog entry in order. */
export function buildReport(
  header: ReportHeader,
  catalog: readonly CatalogEntry[],
  results: ReadonlyMap<string, CardResult>,
  built: ReadonlySet<string>,
): string {
  const idWidth = Math.max(...catalog.map((e) => e.id.length));
  const stateWidth = Math.max(...Object.values(LABEL).map((l) => l.length));
  const hz = header.displayHz == null ? "unknown" : `${Math.round(header.displayHz)} Hz`;
  const top = clean(
    `build ${header.version} dev | webview2 ${header.webview2} | dpr ${header.dpr} | display ${hz} | gl "${header.gl}" | theme ${header.theme}`,
  );
  const rows = catalog.map((e) => line(e, built.has(e.id), results.get(e.id), idWidth, stateWidth));
  return ["Plisto visualizer probes", top, ...rows].join("\n") + "\n";
}
