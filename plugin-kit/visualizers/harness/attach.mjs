/*
 * The server half of the harness for one plugin folder. The harness page itself is served from the kit by the
 * mock server; the visualizer frames need the origin Plisto gives them: the plugin at the root, the runtime
 * under `_plisto`, the frame policy on every file. The checker's server already is that origin, so a harness
 * session starts one and hands the page its address and the kinds the manifest declares.
 */

// -- Library Imports --
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// -- Local Imports --
import { checkManifest } from "../lib/check/manifest.mjs";
import { frameUrl, startServer } from "../lib/check/server.mjs";

/** Whether the folder's plugin.json declares a `visualizers` block. A folder that does not is not served. */
export function declaresVisualizers(dir) {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) return false;
  try {
    const raw = readFileSync(file, "utf8");
    const json = JSON.parse(raw.startsWith(String.fromCharCode(0xfeff)) ? raw.slice(1) : raw);
    return json !== null && typeof json === "object" && "visualizers" in json;
  } catch {
    // A manifest that does not parse still belongs to a visualizer author mid-edit: the page shows why.
    return true;
  }
}

/**
 * Starts the frame origin for `dir`, or resolves null when the folder declares no visualizers. `config()`
 * reads the manifest afresh each call, so a reload after an edit sees the new kinds or the new refusal.
 */
export async function attachHarness(dir) {
  if (!declaresVisualizers(dir)) return null;
  const frames = await startServer(dir, () => ({}));
  return {
    frameBase: frames.base,
    close: frames.close,
    config() {
      const facts = checkManifest(dir);
      if (!facts.ok) return { ok: false, refusal: facts.refusal, frameBase: frames.base };
      return {
        ok: true,
        id: facts.id,
        name: facts.name,
        frameBase: frames.base,
        kinds: facts.decls.map((decl) => ({ decl, src: frameUrl(frames.base, decl) })),
      };
    },
  };
}
