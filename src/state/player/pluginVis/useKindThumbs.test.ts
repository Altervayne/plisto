// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useKindThumbs } from "./useKindThumbs";

// -- State Imports --
import { notifyBuildReplaced } from "../../plugins/buildReplaced";
import { usePluginsStore } from "../../plugins/store";
import { usePluginStatusStore } from "../../plugins/pluginStatus";
import { useNetPolicy } from "./netPolicy";
import { visualizerDecl as decl, visualizerRow as visRow, status } from "../../plugins/fixtures";

const h = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  engine: { sync: vi.fn(), recheck: vi.fn(), rebuild: vi.fn(), dispose: vi.fn(), idle: vi.fn() },
}));

vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useEffect: (fn: () => (() => void) | void) => {
    h.cleanup = fn() || undefined;
  },
}));
vi.mock("./thumbs", async (orig) => ({
  ...(await orig<typeof import("./thumbs")>()),
  createThumbs: () => h.engine,
}));

const rows = () => [visRow("com.example.rings", "Rings", [decl()])];

beforeEach(() => {
  vi.clearAllMocks();
  usePluginsStore.setState({
    rows: rows(),
    boot: { runtime: "running", unclean: false, safe_flag: false } as never,
  });
  usePluginStatusStore.setState({ statuses: {} });
});

afterEach(() => {
  h.cleanup?.();
  h.cleanup = undefined;
});

describe("kind thumbnails wiring", () => {
  it("syncs at start and on a marks change, rebuilds a replaced build and rechecks on a host start", () => {
    useKindThumbs();
    expect(h.engine.sync).toHaveBeenCalledTimes(1);
    useNetPolicy.setState((s) => ({ marks: { ...s.marks } }));
    expect(h.engine.sync).toHaveBeenCalledTimes(2);
    notifyBuildReplaced("com.example.rings");
    expect(h.engine.rebuild).toHaveBeenCalledWith("com.example.rings");
    expect(h.engine.recheck).not.toHaveBeenCalled();
    usePluginStatusStore.setState({
      statuses: { "com.example.rings": status({ host: "starting" } as never) },
    });
    expect(h.engine.recheck).toHaveBeenCalledWith("com.example.rings");
  });

  it("disposes the engine and stops listening on cleanup", () => {
    useKindThumbs();
    h.cleanup?.();
    h.cleanup = undefined;
    expect(h.engine.dispose).toHaveBeenCalledTimes(1);
    notifyBuildReplaced("com.example.rings");
    expect(h.engine.rebuild).not.toHaveBeenCalled();
  });
});
