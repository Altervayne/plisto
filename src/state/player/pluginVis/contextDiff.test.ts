import { describe, expect, it } from "vitest";
import type { HostMessage, VisContext } from "../../../visRuntime/protocol";
import { createContextSync, createContextTracker } from "./contextDiff";

function context(over: Partial<VisContext> = {}): VisContext {
  return {
    layout: {
      width: 800,
      height: 600,
      cover: [10, 20, 100, 100],
      radius: 8,
      mask: null,
      floor: 500,
      hush: [[1, 2, 3, 4]],
    },
    palette: Float32Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9),
    cover: null,
    colors: { ground: [0, 0, 0], backing: [0.1, 0.1, 0.1], ink: [1, 1, 1] },
    light: false,
    reactivity: "balanced",
    ambient: false,
    reducedMotion: false,
    settings: { speed: 1 },
    ...over,
  };
}

const keys = (changed: Partial<VisContext> | null) => Object.keys(changed ?? {});

describe("createContextTracker", () => {
  it("reports nothing for an equal context", () => {
    const tracker = createContextTracker(context());
    expect(tracker.diff(context())).toBeNull();
  });

  it("reports exactly the changed fields", () => {
    const tracker = createContextTracker(context());
    const next = context({ light: true, reactivity: "calm", ambient: true, reducedMotion: true });
    expect(tracker.diff(next)).toEqual({
      light: true,
      reactivity: "calm",
      ambient: true,
      reducedMotion: true,
    });
    expect(tracker.diff(next)).toBeNull();
  });

  it("sees a changed layout, palette, colors and settings by content", () => {
    const base = context();
    const tracker = { diff: (next: VisContext) => createContextTracker(base).diff(next) };
    const wide = { ...base.layout, width: 900 };
    expect(keys(tracker.diff({ ...base, layout: wide }))).toEqual(["layout"]);
    expect(keys(tracker.diff({ ...base, layout: { ...wide, hush: [[1, 2, 3, 5]] } }))).toEqual(["layout"]);
    const masked: VisContext["layout"] = { ...wide, hush: [[1, 2, 3, 5]], mask: [0, 0, 1, 1] };
    expect(keys(tracker.diff({ ...base, layout: masked }))).toEqual(["layout"]);
    const palette = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    expect(keys(tracker.diff({ ...base, palette }))).toEqual(["palette"]);
    expect(keys(tracker.diff({ ...base, colors: { ...base.colors, ink: [0, 0, 0] } }))).toEqual(["colors"]);
    expect(keys(tracker.diff({ ...base, settings: { speed: 2 } }))).toEqual(["settings"]);
    expect(keys(tracker.diff({ ...base, settings: { speed: 2, mode: "a" } }))).toEqual(["settings"]);
  });

  it("compares the cover by identity", () => {
    const bitmap = { width: 1, height: 1, close() {} } as unknown as ImageBitmap;
    const tracker = createContextTracker(context());
    expect(tracker.diff(context({ cover: bitmap }))?.cover).toBe(bitmap);
    expect(tracker.diff(context({ cover: bitmap }))).toBeNull();
  });

  it("still sees a change after the caller mutated its context in place", () => {
    const live = context();
    const tracker = createContextTracker(live);
    live.palette[0] = 0.99;
    expect(tracker.diff(live)).toEqual({ palette: live.palette });
  });
});

describe("createContextSync", () => {
  it("posts an update only when a field changed", () => {
    const posted: HostMessage[] = [];
    const sync = createContextSync(context(), (m) => posted.push(m));
    sync.push(context());
    sync.push(context({ ambient: true }));
    sync.push(context({ ambient: true }));
    expect(posted).toEqual([{ type: "update", context: { ambient: true } }]);
  });
});
