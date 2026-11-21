// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { useVisualizerChoice, type VisualizerChoice } from "./useVisualizerChoice";

// -- Type Imports --
import type { VisualizerKind } from "../../../state/player/visualizerKind";

// -- State Imports --
import { usePluginsStore } from "../../../state/plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../../state/plugins/fixtures";

const h = vi.hoisted(() => ({
  allowed: false,
  picked: "nebula" as string,
  source: "default" as string,
  preview: null as string | null,
  dipTarget: null as string | null,
  dipReady: null as boolean | null,
  coverSrc: null as string | null,
  warmed: [] as string[],
}));

// A static render has no server snapshot, so the store read takes the client one.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("../../../state/player/visualizerWarning", () => ({ useVisualizersAllowed: () => h.allowed }));
vi.mock("../../../state/player/visualizerSheet", () => ({ useVisualizerPreview: () => h.preview }));
vi.mock("../../../state/player/visualizerDefaults", () => ({
  useVisualizerDefaults: { getState: () => ({ status: "ready", load: () => {} }) },
  useVisualizerDefaultsStatus: () => "ready",
}));
vi.mock("../../../state/preferences/store", () => ({
  usePlayerSpectrumLayout: () => "dots",
  usePlayerVisualizerReactivity: () => "balanced",
}));
vi.mock("./useVisualizerResolution", () => ({
  useVisualizerResolution: () => ({
    resolution: { picked: h.picked, source: h.source, defaultKind: "nebula", defaultTier: "album" },
  }),
}));
vi.mock("./useCoverPixels", () => ({
  useCoverPixels: (src: string | null) => {
    h.coverSrc = src;
    return { pixels: null, state: src ? "pending" : "absent" };
  },
}));
vi.mock("./useCoverSeed", () => ({ useCoverSeed: () => ({ pixels: null, state: "absent" }) }));
vi.mock("./useVisualizerDip", () => ({
  useVisualizerDip: (_stage: unknown, target: string, ready: boolean) => {
    h.dipTarget = target;
    h.dipReady = ready;
  },
}));
vi.mock("./gl/warm", () => ({ warmKind: (kind: string) => h.warmed.push(kind) }));
vi.mock("../../../theme", () => ({ isDarkTheme: () => false, subscribeTheme: () => () => {} }));

function choose(): VisualizerChoice {
  let out!: VisualizerChoice;
  function Probe() {
    out = useVisualizerChoice("cover.png", "present", 3, { current: null });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

beforeEach(() => {
  h.allowed = false;
  h.picked = "nebula";
  h.source = "default";
  h.preview = null;
  h.dipTarget = null;
  h.dipReady = null;
  h.coverSrc = null;
  h.warmed = [];
  usePluginsStore.setState({ rows: [], status: "idle", listed: false });
});

describe("useVisualizerChoice gate", () => {
  it.each<[string, string, string]>([
    ["a Cyber pick", "hologram", "pick"],
    ["a Cyber album default", "hologram", "default"],
    ["a Cozy pick", "nebula", "pick"],
  ])("draws nothing for %s while the warning is unacknowledged", (_name, kind, source) => {
    h.picked = kind;
    h.source = source;
    const choice = choose();
    expect(choice.shown).toBe("off");
    expect(h.dipTarget).toBe("off");
    expect(choice.picked).toBe(kind);
    expect(choice.source).toBe(source);
    expect(choice.defaultKind).toBe("nebula");
    expect(choice.defaultTier).toBe("album");
    expect(choice.fallback).toBeNull();
  });

  it("holds a sheet preview off too", () => {
    h.picked = "ridge";
    h.preview = "hologram";
    expect(choose().shown).toBe("off");
    expect(h.dipTarget).toBe("off");
  });

  it("loads no cover pixels and warms no shaders for the held kind", () => {
    h.picked = "nebula";
    choose();
    expect(h.coverSrc).toBeNull();
    expect(h.warmed.every((kind) => kind === "off")).toBe(true);
  });

  it("aims at the real pick once acknowledged, and at a preview over it", () => {
    h.allowed = true;
    h.picked = "hologram";
    choose();
    expect(h.dipTarget).toBe("hologram");
    h.preview = "oscilloscope" as VisualizerKind;
    choose();
    expect(h.dipTarget).toBe("oscilloscope");
  });
});

describe("useVisualizerChoice with a plugin kind waiting on the plugins list", () => {
  const AURORA = "com.example.vis/aurora-rings";

  it("holds the stage as it is, with no fallback line, until the list arrives", () => {
    h.allowed = true;
    h.picked = AURORA;
    usePluginsStore.setState({ status: "failed" });
    const choice = choose();
    expect(choice.shown).toBe("off");
    expect(h.dipTarget).toBe(AURORA);
    expect(h.dipReady).toBe(false);
    expect(choice.picked).toBe(AURORA);
    expect(choice.fallback).toBeNull();
  });

  it("aims at the kind once a listing holds it", () => {
    h.allowed = true;
    h.picked = AURORA;
    usePluginsStore.getState().applyRows([visRow("com.example.vis", "Example", [decl()])]);
    choose();
    expect(h.dipTarget).toBe(AURORA);
    expect(h.dipReady).toBe(true);
  });

  it("never holds a built-in pick", () => {
    h.allowed = true;
    h.picked = "ridge";
    expect(choose().shown).toBe("ridge");
    expect(h.dipReady).toBe(true);
  });
});
