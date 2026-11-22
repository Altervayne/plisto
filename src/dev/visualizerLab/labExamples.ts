/*
 * The lab's `examples` mode: draws the still of every visualizer the plugin kit's examples declare, through
 * the committed runtime bundle, with the frame, feed and seed discipline of `port`. A kind is loaded the way
 * its manifest says: a shader file goes to the runtime's shader form, a page runs its scripts in order
 * against the bundle. Rows are named `<example folder>/<kind id>` so they never meet a fixture kind.
 */

// -- Local Imports --
import { sha256 } from "./labPixels";
import { applyTheme, sceneTheme, type LabLayoutId, type LabTheme } from "./labScene";
import {
  bundleApi,
  drawStill,
  initFor,
  pinPlaying,
  type Namespace,
  type PortRow,
  type PortRun,
} from "./labPort";

// -- Type Imports --
import type { VisInit } from "../../visRuntime/protocol";

const EXAMPLES = "../../../plugin-kit/visualizers/examples/";
const MANIFESTS = import.meta.glob<string>("../../../plugin-kit/visualizers/examples/*/plugin.json", {
  query: "?raw",
  import: "default",
});
const SOURCES = import.meta.glob<string>(
  "../../../plugin-kit/visualizers/examples/*/vis/**/*.{html,js,frag,glsl}",
  { query: "?raw", import: "default" },
);
const MODULE_URLS = import.meta.glob<string>("../../../plugin-kit/visualizers/examples/*/vis/**/*.js", {
  query: "?url",
  import: "default",
});

export interface ExampleSetting {
  id: string;
  type: string;
  default?: unknown;
  min?: number;
  options?: { id: string }[];
}

export interface ExampleDecl {
  id: string;
  page: string | null;
  shader: string | null;
  look: unknown;
  fillsStage: boolean;
  darkOnly: boolean;
  needs: { fine: boolean; cover: boolean; pointer: boolean; waveform: boolean };
  settings: ExampleSetting[];
}

export interface PageScript {
  src: string | null;
  text: string;
  module: boolean;
}

export interface ExampleRun extends Omit<PortRun, "kinds"> {
  example: string | null;
}

/** The row name of a kind of an example. */
export function exampleKind(folder: string, id: string): string {
  return `${folder}/${id}`;
}

/** The visualizers of a manifest, with the fields a mount reads. */
export function parseDecls(manifest: string): ExampleDecl[] {
  const list = (JSON.parse(manifest) as { visualizers?: Record<string, unknown>[] }).visualizers ?? [];
  return list.map((v) => {
    const needs = (v.needs ?? {}) as Record<string, unknown>;
    return {
      id: String(v.id),
      page: typeof v.page === "string" ? v.page : null,
      shader: typeof v.shader === "string" ? v.shader : null,
      look: v.look,
      fillsStage: v.fills_stage === true,
      darkOnly: v.dark_only === true,
      needs: {
        fine: needs.fine === true,
        cover: needs.cover === true,
        pointer: needs.pointer === true,
        waveform: needs.waveform === true,
      },
      settings: Array.isArray(v.settings) ? (v.settings as ExampleSetting[]) : [],
    };
  });
}

/** The composite the runtime tone-maps with, per theme, from a manifest `look`. */
export function compositeOf(look: unknown): VisInit["composite"] {
  if (look === "glow") return { light: "ink", dark: "light" };
  if (look === "image") return { light: "image", dark: "image" };
  const pair = look as { light?: { composite?: string }; dark?: { composite?: string } };
  if (!pair?.light?.composite || !pair?.dark?.composite) {
    throw new Error("a look is neither a name nor a pair");
  }
  return { light: pair.light.composite, dark: pair.dark.composite } as VisInit["composite"];
}

/** Each setting at its declared default, or the value the installer starts it from. */
export function settingDefaults(settings: ExampleSetting[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of settings) {
    if (s.default !== undefined) out[s.id] = s.default;
    else if (s.type === "choice") out[s.id] = s.options?.[0]?.id;
    else if (s.type === "toggle") out[s.id] = false;
    else if (s.type === "range") out[s.id] = s.min;
    else out[s.id] = "cover";
  }
  return out;
}

/** The scripts of a page in document order, without the runtime's own. */
export function pageScripts(html: string): PageScript[] {
  const found: PageScript[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? null;
    if (src?.includes("/_plisto/")) continue;
    found.push({ src, text: m[2], module: /\btype\s*=\s*["']module["']/i.test(m[1]) });
  }
  return found;
}

/** `rel` resolved against the folder `dir`, both without a leading slash. */
export function joinPath(dir: string, rel: string): string {
  const parts = dir === "" ? [] : dir.split("/");
  for (const part of rel.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

const dirOf = (path: string): string => path.split("/").slice(0, -1).join("/");

let moduleLoads = 0;

/** The text of a file of an example, by its path under the example folder. */
async function sourceOf(folder: string, path: string): Promise<string> {
  const load = SOURCES[`${EXAMPLES}${folder}/${path}`];
  if (!load) throw new Error(`${folder}: no file ${path}`);
  return load();
}

/** Runs a page's scripts in order; each module is a fresh copy, so no state outlives its row. */
async function runPage(folder: string, page: string, api: Namespace): Promise<void> {
  const scripts = pageScripts(await sourceOf(folder, page));
  (globalThis as { plistoVis?: unknown }).plistoVis = api;
  for (const script of scripts) {
    if (script.src === null) {
      new Function("plistoVis", script.text)(api);
      continue;
    }
    const path = joinPath(dirOf(page), script.src);
    if (!script.module) {
      new Function("plistoVis", await sourceOf(folder, path))(api);
      continue;
    }
    const load = MODULE_URLS[`${EXAMPLES}${folder}/${path}`];
    if (!load) throw new Error(`${folder}: no module ${path}`);
    const url = await load();
    await import(/* @vite-ignore */ `${url}${url.includes("?") ? "&" : "?"}lab=${++moduleLoads}`);
  }
}

/** Registers one kind of an example on a fresh bundle copy. */
async function registerKind(folder: string, decl: ExampleDecl, stand: Window): Promise<void> {
  const api = bundleApi(stand, { candidate: pinPlaying });
  if (decl.shader !== null) {
    (api.shader as (spec: { source: string }) => void)({ source: await sourceOf(folder, decl.shader) });
  } else if (decl.page !== null) {
    await runPage(folder, decl.page, api);
  } else {
    throw new Error(`${exampleKind(folder, decl.id)}: names neither a page nor a shader`);
  }
}

/** The init `port` builds for a fixture, with the fields the manifest decides. */
function exampleInit(decl: ExampleDecl, theme: LabTheme, layout: LabLayoutId, cover: ImageBitmap): VisInit {
  // "ridge" names no registry scene, so the base carries only the lab's frame, layout and colors.
  const base = initFor("ridge", theme, layout, cover, decl.needs.fine);
  const settings = settingDefaults(decl.settings);
  return {
    ...base,
    kind: decl.id,
    composite: compositeOf(decl.look),
    fillsStage: decl.fillsStage,
    needs: { ...decl.needs },
    settingShapes: decl.settings.map((s) => ({
      id: s.id,
      type: s.type,
      ...(s.type === "choice" && { options: (s.options ?? []).map((o) => o.id) }),
    })) as VisInit["settingShapes"],
    context: { ...base.context, settings } as VisInit["context"],
  };
}

/** The example folders, in name order, narrowed to `only` when it is set. */
function foldersOf(only: string | null): string[] {
  const all = Object.keys(MANIFESTS)
    .map((key) => key.slice(EXAMPLES.length).split("/")[0])
    .sort();
  const folders = only === null ? all : all.filter((f) => f === only);
  if (folders.length === 0) throw new Error(`no example ${only}`);
  return folders;
}

/** The rows of `port`, drawn through the runtime from the plugin kit's examples. */
export async function runExamples(run: ExampleRun): Promise<PortRow[]> {
  const rows: PortRow[] = [];
  for (const folder of foldersOf(run.example)) {
    for (const decl of parseDecls(await MANIFESTS[`${EXAMPLES}${folder}/plugin.json`]())) {
      const kind = exampleKind(folder, decl.id);
      for (const theme of run.themes) {
        const drawn = sceneTheme(decl.darkOnly, theme);
        applyTheme(drawn);
        for (const layout of run.layouts) {
          const bytes = await drawStill(
            (stand) => registerKind(folder, decl, stand),
            exampleInit(decl, drawn, layout, run.cover),
          );
          rows.push({ kind, theme, layout, sha256: await sha256(bytes) });
        }
      }
    }
  }
  return rows;
}
