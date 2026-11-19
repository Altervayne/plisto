// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useGoneRemoval } from "./useGoneRemoval";
import { NOT_SAVED } from "./goneRemove";
import { escapeTarget } from "./goneFocus";
import { createT } from "../../i18n";
import { groupGone } from "../../state/gone/goneGroups";

// -- Type Imports --
import type { AlbumTrackRow, Root, TrackRow } from "../../types";
import type { GoneScope } from "../../state/gone/goneGroups";

// A one-component hook host: state slots survive between calls, setters write straight through.
const host = vi.hoisted(() => ({ slots: [] as unknown[], at: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const k = host.at++;
    if (!(k in host.slots)) host.slots[k] = init;
    return [
      host.slots[k],
      (v: unknown) => {
        host.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(host.slots[k]) : v;
      },
    ];
  },
}));

const t = createT("en");
const render = (purge: Parameters<typeof useGoneRemoval>[0]) => {
  host.at = 0;
  return useGoneRemoval(purge, t);
};

let nextId = 1;
const track = (path: string, gone: boolean): TrackRow =>
  ({ id: nextId++, source_path: path, filename: "x.mp3", missing_at: gone ? 5 : null }) as TrackRow;
const root = (id: number, path: string): Root => ({ id, path, track_count: 100, missing_count: 0 });

beforeEach(() => {
  host.slots = [];
  host.at = 0;
});

describe("Escape ordering", () => {
  it("answers the confirm first and the sheet only once it is gone", () => {
    expect(escapeTarget(true)).toBe("confirm");
    expect(escapeTarget(false)).toBe("sheet");
  });
});

describe("gone removal through its confirm", () => {
  it("shows the mapped message for the restore-point refusal and keeps the sheet's list untouched", async () => {
    const purge = vi.fn().mockRejectedValue(NOT_SAVED);
    render(purge).request([1, 2]);
    await render(purge).confirm();
    const after = render(purge);
    expect(after.error).toContain("Nothing was removed");
    expect(after.error).not.toBe(NOT_SAVED);
    expect(after.receipt).toBeNull();
    expect(after.removing).toBe(false);
  });

  it("shows the receipt after a successful purge, and clears the error", async () => {
    const purge = vi.fn().mockResolvedValue({ removed: 2, albums_emptied: 0 });
    render(purge).request([1, 2]);
    await render(purge).confirm();
    const after = render(purge);
    expect(after.receipt).toBe(2);
    expect(after.error).toBeNull();
    after.finish();
    expect(render(purge).receipt).toBeNull();
  });

  it("does nothing without a confirm open, and cancel closes it", async () => {
    const purge = vi.fn();
    await render(purge).confirm();
    expect(purge).not.toHaveBeenCalled();
    render(purge).request([1]);
    render(purge).cancel();
    expect(render(purge).target).toBeNull();
  });

  describe("passes exactly the scoped ids to the purge", () => {
    const album = [track("/m/a/1.mp3", true), track("/m/a/2.mp3", true)];
    const other = [track("/m/b/1.mp3", true), track("/m/b/2.mp3", true), track("/m/b/3.mp3", true)];
    const present = [track("/m/a/ok.mp3", false), track("/m/b/ok.mp3", false)];
    const tracks = [...album, ...other, ...present];
    const roots = [root(1, "/m/a"), root(2, "/m/b")];
    const members = album.map((tr) => ({ album_id: 9, track_id: tr.id }) as AlbumTrackRow);

    const cases: [string, GoneScope, TrackRow[]][] = [
      ["library", { kind: "all" }, [...album, ...other]],
      ["album", { kind: "album", albumId: 9 }, album],
      ["root", { kind: "root", rootId: 2 }, other],
    ];

    for (const [name, scope, expected] of cases) {
      it(`for the ${name} scope`, async () => {
        const result = groupGone(tracks, roots, [], scope, members);
        const purge = vi.fn().mockResolvedValue({ removed: expected.length, albums_emptied: 0 });
        render(purge).request(result.ids);
        await render(purge).confirm();
        expect(purge).toHaveBeenCalledTimes(1);
        expect([...purge.mock.calls[0][0]].sort()).toEqual(expected.map((e) => e.id).sort());
      });
    }
  });
});
