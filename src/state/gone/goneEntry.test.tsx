// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import {
  goneAfter,
  meetsRailThreshold,
  parseDismissedAt,
  resetGoneMemo,
  useGoneEntry,
  useGoneSummary,
} from "./goneEntry";

// -- Type Imports --
import type { ProjectionState } from "../projectionStatus";
import type { GoneEntry } from "./goneEntry";
import type { GoneResult, GoneScope } from "./goneGroups";

const h = vi.hoisted(() => ({
  status: "ready" as ProjectionState,
  scanning: false,
  tracks: [] as unknown[],
  roots: [] as unknown[],
  offline: [] as number[],
  scope: { kind: "all" } as GoneScope,
  loaded: true,
  raw: undefined as string | undefined,
  failed: false,
  membership: [] as unknown[],
  set: vi.fn(),
}));

vi.mock("../projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ scan: { status: h.scanning ? "scanning" : "idle" }, tracks: h.tracks, roots: h.roots }),
  useOfflineRoots: () => h.offline,
}));
vi.mock("../organize/store", () => ({
  useOrganizeStore: (select: (s: unknown) => unknown) => select({ org: { membership: h.membership } }),
}));
vi.mock("../shell/store", () => ({ useGoneScope: () => h.scope }));
vi.mock("../preferences/store", () => ({
  PREF_KEYS: { goneCardDismissed: "gone_card_dismissed" },
  usePreference: () => h.raw,
  usePreferencesLoaded: () => h.loaded,
  usePreferencesStore: (select: (s: unknown) => unknown) =>
    select({ failedKeys: new Set(h.failed ? ["gone_card_dismissed"] : []) }),
  useSetPreference: () => h.set,
}));

let nextId = 1;
function row(path: string, gone: boolean, at = 5) {
  return { id: nextId++, source_path: path, missing_at: gone ? at : null };
}
function many(folder: string, count: number, gone: boolean, at = 5) {
  return Array.from({ length: count }, (_, i) => row(`${folder}/${i}.mp3`, gone, at));
}
const root = (id: number, path: string) => ({ id, path, track_count: 500, missing_count: 0 });

/** Sixty gone tracks over folders that still hold a present track: over the count threshold, no likely moved. */
function sixty() {
  const out = [row("/m/ok.mp3", false)];
  for (let i = 0; i < 6; i++) out.push(row(`/m/f${i}/ok.mp3`, false), ...many(`/m/f${i}`, 9, true));
  out.push(...many("/m/f0", 6, true));
  return out;
}

let summary: GoneResult | null = null;
let entry: GoneEntry | null = null;

function Probe() {
  summary = useGoneSummary();
  entry = useGoneEntry();
  return null;
}
const run = () => renderToStaticMarkup(<Probe />);

beforeEach(() => {
  resetGoneMemo();
  h.status = "ready";
  h.scanning = false;
  h.tracks = sixty();
  h.roots = [root(1, "/m")];
  h.offline = [];
  h.scope = { kind: "all" };
  h.loaded = true;
  h.raw = undefined;
  h.failed = false;
  h.membership = [];
  h.set.mockClear();
  summary = null;
  entry = null;
});

describe("useGoneSummary", () => {
  it("counts the gone tracks once ready", () => {
    run();
    expect(summary?.total).toBe(60);
  });

  it("yields nothing until the organization has loaded", () => {
    h.status = "loading";
    run();
    expect(summary).toBeNull();
    h.status = "stalled";
    run();
    expect(summary).toBeNull();
  });

  it("follows the scope the shell holds", () => {
    h.scope = { kind: "root", rootId: 9 };
    run();
    expect(summary?.total).toBe(0);
  });

  it("holds its last result while a scan runs and regroups when it ends", () => {
    run();
    expect(summary?.total).toBe(60);
    h.scanning = true;
    h.tracks = [...sixty(), ...many("/m/f1", 5, true)];
    run();
    expect(summary?.total).toBe(60);
    h.scanning = false;
    run();
    expect(summary?.total).toBe(65);
  });

  it("reads the live set when a scan began before any read", () => {
    h.scanning = true;
    run();
    expect(summary?.total).toBe(60);
    h.tracks = [...sixty(), ...many("/m/f1", 5, true)];
    run();
    expect(summary?.total).toBe(65);
  });

  it("shares one grouping between callers on the same state", () => {
    run();
    const first = summary;
    run();
    expect(summary).toBe(first);
  });
});

describe("meetsRailThreshold", () => {
  const result = (total: number, likely: number) => ({ total, likely: new Array(likely) }) as unknown as GoneResult;
  it("needs a likely-moved folder or fifty gone tracks", () => {
    expect(meetsRailThreshold(result(49, 0))).toBe(false);
    expect(meetsRailThreshold(result(50, 0))).toBe(true);
    expect(meetsRailThreshold(result(12, 1))).toBe(true);
  });
});

describe("useGoneEntry", () => {
  it("offers the grouping at the threshold", () => {
    run();
    expect(entry?.summary.total).toBe(60);
  });

  it("offers nothing below the threshold", () => {
    h.tracks = [row("/m/f/ok.mp3", false), ...many("/m/f", 49, true)];
    run();
    expect(entry).toBeNull();
  });

  it("offers a small likely-moved folder", () => {
    h.tracks = [row("/m/ok.mp3", false), ...many("/m/Rock", 10, true)];
    run();
    expect(entry?.summary.likely).toHaveLength(1);
  });

  it("ignores gone tracks on an offline root", () => {
    h.offline = [1];
    run();
    expect(entry).toBeNull();
  });

  it("offers nothing while the organization or the preferences have not loaded", () => {
    h.status = "loading";
    run();
    expect(entry).toBeNull();
    h.status = "ready";
    h.loaded = false;
    run();
    expect(entry).toBeNull();
  });

  it("stays quiet when the dismissal could not be read", () => {
    h.failed = true;
    run();
    expect(entry).toBeNull();
    expect(summary?.total).toBe(60);
  });

  it("stores the newest missing_at on dismiss", () => {
    h.tracks = [...sixty(), row("/m/f3/late.mp3", true, 9)];
    run();
    entry?.dismiss();
    expect(h.set).toHaveBeenCalledWith("gone_card_dismissed", "9");
  });

  it("stays hidden once dismissed, as the set shrinks, and when a track returns", () => {
    run();
    h.raw = "5";
    run();
    expect(entry).toBeNull();
    h.tracks = (h.tracks as unknown[]).slice(0, 70);
    run();
    expect(entry).toBeNull();
  });

  it("returns when a track goes missing after the dismissal", () => {
    h.raw = "5";
    h.tracks = [...sixty(), row("/m/f2/late.mp3", true, 6)];
    run();
    expect(entry?.summary.total).toBe(61);
  });

  it("returns when a track that came back goes missing again later", () => {
    h.raw = "5";
    h.tracks = sixty().map((t, i) => (i === 3 ? { ...t, missing_at: 12 } : t));
    run();
    expect(entry).not.toBeNull();
  });
});

describe("dismissed mark", () => {
  it("reads a stored number and treats anything else as none", () => {
    expect(parseDismissedAt("7")).toBe(7);
    expect(parseDismissedAt(undefined)).toBeNull();
    expect(parseDismissedAt("")).toBeNull();
    expect(parseDismissedAt("nope")).toBeNull();
  });

  it("returns only for a track newer than the mark", () => {
    expect(goneAfter(5, 5)).toBe(false);
    expect(goneAfter(6, 5)).toBe(true);
    expect(goneAfter(5, null)).toBe(true);
    expect(goneAfter(null, 5)).toBe(false);
  });
});
