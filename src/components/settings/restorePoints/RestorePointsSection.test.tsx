// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The static renderer has no portal target, so sheets and tooltips render in place.
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.stubGlobal("document", { body: {} });
vi.mock("../../../lib/ipc", () => ({}));

// The server renderer reads a zustand store's initial snapshot, so the section reads a plain stand-in.
const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  allowed: true,
  scanning: false,
}));
vi.mock("../../../state/restorePoints/store", () => ({
  useRestorePointsStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) => select(fake.state),
    { getState: () => fake.state },
  ),
  useRestoreRunning: () => fake.state.running === true,
  useRestoreAllowed: () => fake.allowed,
}));
vi.mock("../../../state/store", () => ({
  useScanStatus: () => (fake.scanning ? "scanning" : "idle"),
}));

// -- Unit Imports --
import { RestorePointsSection } from "./RestorePointsSection";

// -- i18n Imports --
import { en } from "../../../i18n/en";

// -- Type Imports --
import type { RestorePointRow } from "../../../types";

const point = (file: string, over: Partial<RestorePointRow> = {}): RestorePointRow => ({
  file,
  reason: "daily",
  created_at: new Date(2026, 10, 19, 11, 5).getTime(),
  bytes: 1,
  status: {
    kind: "ready",
    app_version: "2.7.2",
    detail: null,
    albums: 5,
    singles: 1,
    playlists: 2,
    filed_tracks: 10,
    edited_tracks: 0,
    genre_tracks: 0,
  },
  ...over,
});

const base = {
  points: [] as RestorePointRow[],
  diskPoints: 0,
  diskBytes: 0,
  loaded: true,
  error: null as string | null,
  running: false,
  result: null,
  load: () => Promise.resolve(),
  clearResult: () => {},
};

const render = () => renderToStaticMarkup(<RestorePointsSection />);

beforeEach(() => {
  fake.allowed = true;
  fake.scanning = false;
  fake.state = { ...base };
});

describe("RestorePointsSection", () => {
  it("shows the heading, the helper, and the registry stamp", () => {
    const html = render();
    expect(html).toContain(en.restorePoints.section);
    expect(html).toContain('data-setting-id="restorePoints"');
    expect(html).toContain('data-settings-section="restorePoints"');
  });

  it("shows the empty state, with no disk line, when no point exists", () => {
    const html = render();
    expect(html).toContain(en.restorePoints.emptyTitle);
    expect(html).not.toContain("restore points,");
    expect(html).not.toContain(en.restorePoints.restore);
  });

  it("shows nothing of the list before the first read lands", () => {
    fake.state = { ...base, loaded: false };
    expect(render()).not.toContain(en.restorePoints.emptyTitle);
  });

  it("lists the points with the disk line under them", () => {
    fake.state = {
      ...base,
      points: [point("a"), point("b", { reason: "version" })],
      diskPoints: 17,
      diskBytes: 48 * 1024 * 1024,
    };
    const html = render();
    expect(html.match(/data-point=/g)).toHaveLength(2);
    expect(html).toContain("17 restore points, 48 MB");
    expect(html).not.toContain(en.restorePoints.emptyTitle);
  });

  it("words a single point in the singular", () => {
    fake.state = { ...base, points: [point("a")], diskPoints: 1, diskBytes: 2048 };
    expect(render()).toContain("1 restore point, 2.0 KB");
  });

  it("flags unreadable and newer points in the list", () => {
    fake.state = {
      ...base,
      points: [
        point("a", { status: { kind: "unreadable", error: "bad" } }),
        point("b", { status: { kind: "newer", format: 9 } }),
        point("c"),
      ],
      diskPoints: 3,
      diskBytes: 100,
    };
    const html = render();
    expect(html).toContain(en.restorePoints.newer);
    expect(html).toContain(en.restorePoints.newerLine);
    expect(html.split(en.restorePoints.restore).length - 1).toBe(1);
  });

  it("holds every Restore while a scan runs, and says nothing about it until a refusal", () => {
    fake.state = { ...base, points: [point("a")], diskPoints: 1, diskBytes: 1 };
    fake.allowed = false;
    fake.scanning = true;
    const html = render();
    expect(html).toContain("disabled");
    expect(html).not.toContain(en.restorePoints.nothingChanged);
  });

  it("shows the scan refusal as a line, with Nothing was changed, and no sheet", () => {
    fake.state = {
      ...base,
      points: [point("a")],
      diskPoints: 1,
      diskBytes: 1,
      result: { kind: "refused", file: "a", failure: { key: "busy", detail: null } },
    };
    fake.allowed = false;
    fake.scanning = true;
    const html = render();
    expect(html).toContain(en.settings.locateBusy);
    expect(html).toContain(en.restorePoints.nothingChanged);
    expect(html).not.toContain(en.restorePoints.failTitle);
  });

  it("shows the status line with the pill while a restore runs, and holds Restore", () => {
    fake.state = { ...base, points: [point("a")], diskPoints: 1, diskBytes: 1, running: true };
    fake.allowed = false;
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain(en.restorePoints.workingLine);
    expect(html).toContain("disabled");
  });

  it("opens the result sheet for a finished restore, with the new before-restore point listed", () => {
    fake.state = {
      ...base,
      points: [point("before", { reason: "restore" }), point("a")],
      diskPoints: 2,
      diskBytes: 1,
      result: {
        kind: "done",
        file: "a",
        beforePoint: "before",
        summary: {
          albums: 5,
          singles: 1,
          playlists: 2,
          filed_tracks: 10,
          unmatched_tracks: 0,
          albums_not_recreated: 0,
          collapsed: 0,
          dropped_entries: 0,
          cleared_tracks: 0,
          unmatched: [],
        },
      },
    };
    const html = render();
    expect(html).toContain("Restored the point of 19 Nov 2026, 11:05");
    expect(html).toContain(">Undo restore<");
    expect(html).toContain(">Before a restore<");
  });

  it("opens the failure sheet for a refused restore", () => {
    fake.state = {
      ...base,
      points: [point("a")],
      diskPoints: 1,
      diskBytes: 1,
      result: { kind: "refused", file: "a", failure: { key: "before_point", detail: "full" } },
    };
    const html = render();
    expect(html).toContain(en.restorePoints.failPrompt);
    expect(html).toContain(en.restorePoints.failBeforePoint.replace(/'/g, "&#x27;"));
  });
});
