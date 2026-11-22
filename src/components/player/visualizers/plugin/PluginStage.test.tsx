// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PluginStage } from "./PluginStage";
import { usePluginStageMount, type PluginStageProps, type PluginStageView } from "./usePluginStageMount";

// -- State Imports --
import { pluginVisualizer, type PluginKindId } from "../../../../state/player/pluginVisualizers";
import { phaseOf, stageHandles, useFrameCache } from "../../../../state/player/pluginVis/frameCache";
import { useFrameHealthStore } from "../../../../state/plugins/frameHealth";
import { usePluginsStore } from "../../../../state/plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../../../state/plugins/fixtures";
import type { PluginVisualizerNeeds } from "../../../../state/plugins/visualizerDecl";

interface Effect {
  deps: readonly unknown[];
  cleanup: (() => void) | undefined;
}

const h = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refAt: 0,
  states: [] as unknown[],
  stateAt: 0,
  effects: [] as (Effect | undefined)[],
  effectAt: 0,
  attach: vi.fn(),
  detach: vi.fn(),
  loaded: "first" as "first" | "again",
  url: vi.fn(() => Promise.resolve("http://pv-1.invalid/vis/rings.html")),
  releaseFine: vi.fn(),
  acquireFine: vi.fn(),
}));

// Refs, state and effects persist across renders by call order. An effect runs in place when its
// dependencies change, after the cleanup of its last run, as it would after a commit.
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  const effect = (fn: () => void | (() => void), deps: readonly unknown[]) => {
    const at = h.effectAt++;
    const prev = h.effects[at];
    if (prev && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
    prev?.cleanup?.();
    const cleanup = fn();
    h.effects[at] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  };
  return {
    ...real,
    useRef: (init: unknown) => (h.refs[h.refAt++] ??= { current: init }),
    useState: (init: unknown) => {
      const at = h.stateAt++;
      if (!(at in h.states)) h.states[at] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (next: unknown) => {
        h.states[at] = typeof next === "function" ? (next as (v: unknown) => unknown)(h.states[at]) : next;
      };
      return [h.states[at], set];
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  };
});
// A static render reads a store's initial state; hooks read the live state instead.
vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});
vi.mock("../../../../state/plugins/pluginHost", () => ({
  attachFrame: h.attach,
  detachFrame: h.detach,
  frameLoaded: () => h.loaded,
}));
vi.mock("../../../../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../../../../lib/ipc")>()),
  pluginVisUrl: h.url,
}));
vi.mock("../../../../state/player/spectrum", async (orig) => ({
  ...(await orig<typeof import("../../../../state/player/spectrum")>()),
  acquireFineSpectrum: h.acquireFine,
}));
vi.mock("../../../../theme", () => ({ isDarkTheme: () => true, subscribeTheme: () => () => {} }));
vi.mock("../../../../i18n", () => ({ useT: () => (_pick: unknown, vars: { name: string }) => vars.name }));

const KIND = "com.example.rings/aurora-rings" as PluginKindId;
let observed: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
const win = { postMessage: vi.fn() };

function props(over: Partial<PluginStageProps> = {}): PluginStageProps {
  return {
    descriptor: pluginVisualizer(KIND)!,
    surface: "player",
    shown: false,
    ambient: false,
    coverRef: { current: null },
    palette: new Float32Array(9),
    pixels: null,
    reactivity: "balanced",
    onFail: vi.fn(),
    ...over,
  };
}

function render(p: PluginStageProps): PluginStageView {
  h.refAt = 0;
  h.stateAt = 0;
  h.effectAt = 0;
  let view!: PluginStageView;
  function Probe() {
    view = usePluginStageMount(p, "vis|player|test");
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return view;
}

function unmount() {
  for (const effect of h.effects.splice(0)) effect?.cleanup?.();
}

/** Mounts a stage up to its first load, with the frame's window and the slot in place. */
async function loaded(p: PluginStageProps): Promise<PluginStageView> {
  const first = render(p);
  first.slotRef.current = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 80 }),
    style: {},
  } as unknown as HTMLDivElement;
  await Promise.resolve();
  await Promise.resolve();
  const frame = { contentWindow: win, src: "http://pv-1.invalid/" };
  first.iframeRef.current = frame as unknown as HTMLIFrameElement;
  const view = render(p);
  view.onLoad();
  return view;
}

// The visualizer table follows the plugins store's rows.
function withNeeds(needs: Partial<PluginVisualizerNeeds>) {
  const all = { fine: false, cover: false, pointer: false, waveform: false, ...needs };
  usePluginsStore.setState({ rows: [visRow("com.example.rings", "Rings", [decl({ needs: all })])] });
}

beforeEach(() => {
  h.refs = [];
  h.states = [];
  h.effects = [];
  h.loaded = "first";
  h.acquireFine.mockReturnValue(h.releaseFine);
  usePluginsStore.setState({ boot: { runtime: "running", unclean: false, safe_flag: false } });
  withNeeds({});
  useFrameCache.setState({ wants: {}, phases: {} });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("getComputedStyle", () => ({ color: "rgb(10, 20, 30)", borderTopLeftRadius: "0px" }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("plugin stage mount", () => {
  it("attaches the frame with the visualizer role and sends init with its port", async () => {
    await loaded(props());
    expect(h.url).toHaveBeenCalledWith("com.example.rings", "aurora-rings");
    expect(h.attach).toHaveBeenCalledWith("vis|player|test", "com.example.rings", win, "visualizer");
    const [init, origin, transfer] = win.postMessage.mock.calls[0];
    expect(init).toMatchObject({ type: "plisto:vis-init", kind: "aurora-rings", meter: false });
    expect(origin).toBe("*");
    expect(transfer).toHaveLength(1);
    expect(stageHandles()).toHaveLength(1);
    unmount();
    expect(h.detach).toHaveBeenCalledWith("vis|player|test");
    expect(stageHandles()).toHaveLength(0);
  });

  it("never writes frame health, whatever the frame does", async () => {
    const before = useFrameHealthStore.getState();
    const writes = vi.fn();
    const stop = useFrameHealthStore.subscribe(writes);
    h.loaded = "again";
    await loaded(props());
    unmount();
    h.loaded = "first";
    await loaded(props());
    unmount();
    stop();
    expect(writes).not.toHaveBeenCalled();
    expect(useFrameHealthStore.getState()).toBe(before);
  });

  it("gives the mount up on a second load, with no crash", async () => {
    h.loaded = "again";
    await loaded(props());
    expect(win.postMessage).not.toHaveBeenCalled();
    expect(phaseOf("player", KIND)).toBe("dropped");
  });

  it("gives the mount up while the plugin runtime is held", () => {
    usePluginsStore.setState({ boot: { runtime: "held", unclean: false, safe_flag: false } });
    render(props());
    expect(h.url).not.toHaveBeenCalled();
    expect(phaseOf("player", KIND)).toBe("dropped");
  });

  it("releases the fine spectrum hold on unmount", async () => {
    withNeeds({ fine: true });
    await loaded(props());
    observed?.([{ isIntersecting: true }]);
    expect(h.acquireFine).toHaveBeenCalledTimes(1);
    unmount();
    expect(h.releaseFine).toHaveBeenCalledTimes(1);
    expect(phaseOf("player", KIND)).toBeUndefined();
  });
});

describe("plugin stage markup", () => {
  it("is an inert, hidden slot with the frame and nothing else until it draws", async () => {
    const p = props({ shown: true });
    const markup = () => {
      h.refAt = 0;
      h.stateAt = 0;
      h.effectAt = 0;
      return renderToStaticMarkup(<PluginStage {...p} />);
    };
    expect(markup()).not.toContain("<iframe");
    await Promise.resolve();
    await Promise.resolve();
    const html = markup();
    const slot = /^<div class="[^"]*held[^"]*" style="mix-blend-mode:screen" inert="" aria-hidden="true">/;
    expect(html).toMatch(slot);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html.match(/<div/g)).toHaveLength(1);
  });
});

describe("plugin stage sources", () => {
  const SOURCES = import.meta.glob<string>("./*.{ts,tsx}", { eager: true, query: "?raw", import: "default" });
  const sources = Object.entries(SOURCES).filter(([path]) => !/\.test\.tsx?$/.test(path));

  it("load no page overlay, crash card or heartbeat, and never write frame health", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const [path, text] of sources) {
      expect(text, path).not.toMatch(/NotRespondingOverlay|useFrameHeartbeat|PluginFrame\b|CrashCard/);
      expect(text, path).not.toMatch(/useFrameHealthStore\.getState\(\)|\.setPhase\(|\.crash\(/);
    }
  });
});

describe("plugin stage under reduced motion", () => {
  it("draws the still on a canvas and mounts no live frame", async () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      documentElement: {},
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const watcher = class {
      observe() {}
      disconnect() {}
    };
    vi.stubGlobal("ResizeObserver", watcher);
    vi.stubGlobal("MutationObserver", watcher);
    h.refAt = 0;
    h.stateAt = 0;
    h.effectAt = 0;
    const html = renderToStaticMarkup(<PluginStage {...props({ shown: true })} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(html).toContain("<canvas");
    expect(html).not.toContain("<iframe");
    expect(h.url).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
    expect(stageHandles()).toHaveLength(0);
    expect(phaseOf("player", KIND)).toBeDefined();
    unmount();
    expect(phaseOf("player", KIND)).toBeUndefined();
  });
});
