// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  buildSig,
  CRUMBS_KEY,
  leaveCrumb,
  startCrumbSweep,
  sweepCrumbs,
  type Crumb,
} from "./offscreenCrumbs";
import { watchMount } from "./stillMount";

// -- State Imports --
import { useNetPolicy } from "./netPolicy";
import { usePluginsStore } from "../../plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";

const mark = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./netPolicy", async (orig) => ({
  ...(await orig<typeof import("./netPolicy")>()),
  writeVisMark: mark,
}));

const ROW = visRow("com.example.rings", "Rings", [decl()], { version: "1.0.0", installed_at: 7 });
const KIND = { kind: "com.example.rings/aurora-rings" as const, pluginId: ROW.id, kindId: "aurora-rings" };

/** A map-backed storage, as the page's local storage behaves. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

const stored = (): Crumb[] => JSON.parse(localStorage.getItem(CRUMBS_KEY) ?? "[]");

const earlier = (over: Partial<Crumb> = {}): Crumb => ({
  id: "earlier:1",
  launch: "earlier",
  pluginId: ROW.id,
  kindId: "aurora-rings",
  sig: buildSig(ROW),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", memoryStorage());
  usePluginsStore.setState({ rows: [ROW], listed: false, boot: null });
  useNetPolicy.setState({ loaded: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offscreen crash crumbs", () => {
  it("leaves a crumb for each mount with its build, and its release removes only that one", () => {
    const first = leaveCrumb(ROW.id, "aurora-rings");
    const second = leaveCrumb(ROW.id, "aurora-rings");
    expect(stored()).toHaveLength(2);
    expect(stored()[0]).toMatchObject({ pluginId: ROW.id, kindId: "aurora-rings", sig: "1.0.0|hash-1|7" });
    expect(stored()[0].id).not.toBe(stored()[1].id);
    first();
    first();
    expect(stored()).toHaveLength(1);
    second();
    expect(localStorage.getItem(CRUMBS_KEY)).toBeNull();
  });

  it("leaves a crumb for a still mount's watch and removes it on release", () => {
    const release = watchMount(KIND);
    expect(stored()).toHaveLength(1);
    release();
    expect(stored()).toHaveLength(0);
  });

  it("marks the kind of an earlier launch's crumb after an unclean exit, then clears it", () => {
    localStorage.setItem(CRUMBS_KEY, JSON.stringify([earlier(), earlier({ id: "earlier:2" })]));
    const live = leaveCrumb(ROW.id, "aurora-rings");
    sweepCrumbs([ROW], true);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith(KIND.kind, ROW.id, "aurora-rings", "graphics_reset");
    // The crumb of this launch's live mount stays.
    expect(stored()).toHaveLength(1);
    live();
    expect(stored()).toHaveLength(0);
  });

  it("drops a crumb of a build no longer installed without a mark", () => {
    localStorage.setItem(
      CRUMBS_KEY,
      JSON.stringify([earlier({ sig: "0.9.0|hash-0|3" }), earlier({ id: "earlier:2", pluginId: "gone" })]),
    );
    sweepCrumbs([ROW], true);
    expect(mark).not.toHaveBeenCalled();
    expect(localStorage.getItem(CRUMBS_KEY)).toBeNull();
  });

  it("clears a matching crumb without a mark after a clean exit", () => {
    localStorage.setItem(CRUMBS_KEY, JSON.stringify([earlier()]));
    sweepCrumbs([ROW], false);
    expect(mark).not.toHaveBeenCalled();
    expect(localStorage.getItem(CRUMBS_KEY)).toBeNull();
  });

  it("sweeps once the marks, the rows and the boot state have all been read", () => {
    localStorage.setItem(CRUMBS_KEY, JSON.stringify([earlier()]));
    const stop = startCrumbSweep();
    useNetPolicy.setState({ loaded: true });
    usePluginsStore.setState({ listed: true });
    // The boot state is unknown: nothing is swept yet.
    expect(mark).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
    usePluginsStore.setState({ boot: { runtime: "running", unclean: true, safe_flag: false } });
    expect(mark).toHaveBeenCalledTimes(1);
    localStorage.setItem(CRUMBS_KEY, JSON.stringify([earlier()]));
    usePluginsStore.setState({ rows: [ROW] });
    expect(mark).toHaveBeenCalledTimes(1);
    stop();
  });

  it("tolerates storage that throws or is missing", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("localStorage", throwing);
    expect(() => leaveCrumb(ROW.id, "aurora-rings")()).not.toThrow();
    expect(() => sweepCrumbs([ROW], true)).not.toThrow();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    expect(() => watchMount(KIND)()).not.toThrow();
    expect(() => sweepCrumbs([ROW], true)).not.toThrow();
    expect(mark).not.toHaveBeenCalled();
  });
});
