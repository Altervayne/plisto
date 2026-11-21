// -- Test Imports --
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** The source files, relative to src, with their text; tests excluded. */
const files = Object.entries(SOURCES)
  .filter(([path]) => !/\.test\.tsx?$/.test(path))
  .map(([path, text]) => [path.replace("/src/", ""), text] as const);

const textOf = (file: string): string => files.find(([path]) => path === file)?.[1] ?? "";

// -- Scanners (each takes a source string, so a self-test can feed it a fake one) --

/** Whether `source` loads a module named `name` by a static import, a dynamic import or a require. */
export function loadsModule(source: string, name: string): boolean {
  const target = `["'\`][^"'\`]*/${name}["'\`]`;
  return new RegExp(`from\\s+${target}|import\\s*\\(\\s*${target}|require\\s*\\(\\s*${target}`).test(source);
}

/** Whether `source` loads a module under the folder path `folder` (such as `gl/renderer`). */
export function loadsPath(source: string, folder: string): boolean {
  const target = `["'\`][^"'\`]*${folder}["'\`]`;
  return new RegExp(`from\\s+${target}|import\\s*\\(\\s*${target}|require\\s*\\(\\s*${target}`).test(source);
}

/** Whether `source` mounts the gated `<Visualizer` component. */
export const mountsVisualizer = (source: string): boolean => /<Visualizer[\s/>]/.test(source);

/** Whether `source` calls the hook that gives a mounted `<Visualizer` its gated choice. */
export const buildsGatedChoice = (source: string): boolean => /\buseVisualizerChoice\s*\(/.test(source);

/** Whether `source` reads the gate: a call to `useVisualizersAllowed` or `warningStatus`. */
export const readsGate = (source: string): boolean => /\b(?:useVisualizersAllowed|warningStatus)\s*\(/.test(source);

const importers = (name: string): string[] =>
  files.filter(([, text]) => loadsModule(text, name)).map(([path]) => path);

const underDev = (file: string): boolean => file.startsWith("dev/");

const allowedDrawers = (file: string): boolean =>
  file === "components/player/visualizers/Visualizer.tsx" ||
  file === "components/player/NowPlayingWidget.tsx" ||
  underDev(file);

const VISUALIZER_MOUNTERS = [
  "components/player/PlayerView.tsx",
  "components/player/ambient/AmbientStage.tsx",
];

describe("visualizer gate guard", () => {
  it("scans the sources", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it.each(["GlVisualizer", "SpectrumRidge"])("%s is drawn only by the gated stage, the widget and dev code", (name) => {
    expect(importers(name).length).toBeGreaterThan(0);
    expect(importers(name).filter((file) => !allowedDrawers(file))).toEqual([]);
  });

  it("only GlVisualizer, the scenes, the plugin visualizer runtime and dev code load the renderer", () => {
    const offenders = files
      .filter(([, text]) => loadsPath(text, "gl/renderer") || loadsModule(text, "renderer"))
      .map(([path]) => path)
      .filter(
        (file) =>
          file !== "components/player/visualizers/GlVisualizer.tsx" &&
          !file.startsWith("components/player/visualizers/gl/") &&
          !file.startsWith("visRuntime/") &&
          !underDev(file),
      );
    expect(offenders).toEqual([]);
  });

  it("mounts the gated Visualizer only where its choice comes from the choice hook", () => {
    const mounters = files.filter(([, text]) => mountsVisualizer(text)).map(([path]) => path);
    expect(mounters.filter((file) => !VISUALIZER_MOUNTERS.includes(file) && !underDev(file))).toEqual([]);
    for (const file of VISUALIZER_MOUNTERS) expect(buildsGatedChoice(textOf(file))).toBe(true);
  });

  it("the choice hook reads the gate", () => {
    expect(readsGate(textOf("components/player/visualizers/useVisualizerChoice.ts"))).toBe(true);
  });

  it("the sheet store reads the gate", () => {
    expect(readsGate(textOf("state/player/visualizerSheet.ts"))).toBe(true);
  });

  it("the Player's aurora reads the gate", () => {
    const view = textOf("components/player/PlayerView.tsx");
    expect(readsGate(view)).toBe(true);
    expect(view).toMatch(/<Aurora[^>]*eased=\{/);
  });
});

describe("scanner self-tests", () => {
  it("sees a static, a dynamic and a required load of a module", () => {
    expect(loadsModule('import { X } from "./GlVisualizer";', "GlVisualizer")).toBe(true);
    expect(loadsModule('const m = await import("../GlVisualizer");', "GlVisualizer")).toBe(true);
    expect(loadsModule("const m = React.lazy(() => import('./GlVisualizer'))", "GlVisualizer")).toBe(true);
    expect(loadsModule('const m = require("./GlVisualizer");', "GlVisualizer")).toBe(true);
    expect(loadsModule('import { X } from "./OtherVisualizer";', "GlVisualizer")).toBe(false);
  });

  it("sees a direct load of the renderer", () => {
    expect(loadsPath('import { draw } from "./gl/renderer";', "gl/renderer")).toBe(true);
    expect(loadsPath('await import("../visualizers/gl/renderer")', "gl/renderer")).toBe(true);
    expect(loadsPath('import { x } from "./gl/scene";', "gl/renderer")).toBe(false);
  });

  it("sees a Visualizer mounted without the choice hook", () => {
    const handMade = 'return <Visualizer choice={{ shown: "ridge" }} trackId={1} />;';
    expect(mountsVisualizer(handMade)).toBe(true);
    expect(buildsGatedChoice(handMade)).toBe(false);
    expect(mountsVisualizer("<Visualizer\n  choice={choice}")).toBe(true);
    expect(buildsGatedChoice("const choice = useVisualizerChoice(src, status, id, ref);")).toBe(true);
    expect(mountsVisualizer("<VisualizerSheet place=\"player\" />")).toBe(false);
  });

  it("sees whether a source reads the gate", () => {
    expect(readsGate("const allowed = useVisualizersAllowed();")).toBe(true);
    expect(readsGate("const s = warningStatus(loaded, failed, values);")).toBe(true);
    expect(readsGate("// uses useVisualizersAllowed in a comment only")).toBe(false);
    expect(readsGate("const allowed = true;")).toBe(false);
  });
});
