/*
 * Runs the kinds of a plugin through the host page in headless Edge, over the kit's copy of the Edge runner,
 * and saves each kind's still as a PNG. The runner finds its page by the `visualizer-lab` part of the URL and
 * reads the JSON the page leaves in #out.
 */

// -- Library Imports --
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -- Local Imports --
import { runEdgeLive } from "../edgeLive.mjs";
import { frameUrl, startServer } from "./server.mjs";

// How long a kind may take to draw its first frame. Pre-ready time is not a limit of Plisto's.
export const READY_WAIT_MS = 20000;
// The headroom per kind for the still, and for the run as a whole.
const STILL_ALLOWANCE_MS = 25000;
const RUN_ALLOWANCE_MS = 60000;

const EDGES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const SOFTWARE_GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** The Edge executable: the one asked for, or the first installed. Throws when there is none. */
export function findEdge(asked) {
  const found = asked ?? EDGES.find((path) => existsSync(path));
  if (!found || !existsSync(found)) throw new Error("Edge was not found; pass its path with --edge");
  return found;
}

/**
 * Plays the scripted feed on each kind for `seconds` and returns one raw result per kind, with the still
 * saved under `outDir` (made when not given). `soft` forces software GL; the default is the real GPU.
 */
export async function runKinds({ dir, decls, seconds, edge, soft, outDir }) {
  const exe = findEdge(edge);
  const stills = outDir ?? mkdtempSync(join(tmpdir(), "plisto-kit-check-stills-"));
  mkdirSync(stills, { recursive: true });
  const server = await startServer(dir, (base) => ({
    seconds,
    readyWaitMs: READY_WAIT_MS,
    kinds: decls.map((decl) => ({ decl, src: frameUrl(base, decl) })),
  }));
  try {
    const timeoutMs = decls.length * (READY_WAIT_MS + seconds * 1000 + STILL_ALLOWANCE_MS) + RUN_ALLOWANCE_MS;
    const args = soft ? SOFTWARE_GL : [];
    const text = await runEdgeLive({ edge: exe, args, url: server.hostUrl, timeoutMs });
    const parsed = JSON.parse(text);
    if (parsed.error) throw new Error(`the host page failed: ${parsed.error}`);
    for (const result of parsed.results) {
      if (!result.png) continue;
      result.stillPath = join(stills, `${result.id}.png`);
      writeFileSync(result.stillPath, Buffer.from(result.png.split(",")[1], "base64"));
      delete result.png;
    }
    return { results: parsed.results, stills };
  } finally {
    await server.close();
  }
}
