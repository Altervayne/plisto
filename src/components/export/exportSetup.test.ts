// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  DEFAULT_SETUP,
  MAX_DESTS,
  destKey,
  fitToTarget,
  hasRecord,
  parseSetups,
  rememberPick,
  rememberRun,
  restorePlan,
  settleRestore,
  setupFor,
  setupOnPick,
} from "./exportSetup";

// -- Type Imports --
import type { ExportTarget } from "../../types";
import type { Setup } from "./exportSetup";

const folderA: ExportTarget = { kind: "folder", path: "D:/Music/Backup" };
const folderB: ExportTarget = { kind: "folder", path: "E:\\Other" };
const phone: ExportTarget = {
  kind: "device",
  target: { device_name: "Pixel", display: "Pixel > Internal > Music", pidl: "aa" },
};

const custom: Setup = {
  folder: "{album}",
  file: "{title}",
  albums: false,
  singles: true,
  playlists: true,
  shape: "file",
  deviceInPlace: true,
  scope: "changed",
};

describe("destKey", () => {
  it("folds separators and case like the ledger key", () => {
    expect(destKey(folderA)).toBe("d:\\music\\backup");
    expect(destKey({ kind: "folder", path: "D:\\MUSIC\\Backup" })).toBe("d:\\music\\backup");
  });

  it("prefixes a device with the folded breadcrumb and ignores its handle", () => {
    expect(destKey(phone)).toBe("device:pixel > internal > music");
    const moved: ExportTarget = { kind: "device", target: { ...phone.target, pidl: "bb" } };
    expect(destKey(moved)).toBe(destKey(phone));
  });
});

describe("parseSetups", () => {
  it("yields the defaults for absent, corrupt and non-object input", () => {
    for (const raw of [undefined, null, "", "{not json", "42", "[]", "null"]) {
      const s = parseSetups(raw);
      expect(s.last).toEqual({ ...DEFAULT_SETUP, target: null });
      expect(s.dests).toEqual({});
    }
  });

  it("seeds the last layout from the given patterns when the blob has none", () => {
    const s = parseSetups(undefined, { folder: "{album}", file: "{title}" });
    expect(s.last.folder).toBe("{album}");
    expect(s.last.file).toBe("{title}");
  });

  it("falls back per field and ignores unknown fields", () => {
    const raw = JSON.stringify({
      v: 7,
      extra: true,
      last: { albums: false, singles: "yes", scope: "nope", shape: "file", folder: 3, surprise: 1 },
    });
    const s = parseSetups(raw);
    expect(s.last.albums).toBe(false);
    expect(s.last.singles).toBe(true);
    expect(s.last.scope).toBe("all");
    expect(s.last.shape).toBe("file");
    expect(s.last.folder).toBe(DEFAULT_SETUP.folder);
    expect(s.v).toBe(1);
  });

  it("keeps an empty folder pattern, a real value", () => {
    expect(parseSetups(JSON.stringify({ last: { folder: "" } })).last.folder).toBe("");
  });

  it("drops a destination entry with no usable target and keeps a partial one", () => {
    const raw = JSON.stringify({
      dests: {
        bad: { setup: custom, target: { kind: "folder" }, usedAt: 1 },
        notObject: 5,
        ok: { setup: { scope: "changed" }, target: folderA, usedAt: "x" },
      },
    });
    const s = parseSetups(raw);
    expect(Object.keys(s.dests)).toEqual(["ok"]);
    expect(s.dests.ok.setup.scope).toBe("changed");
    expect(s.dests.ok.setup.albums).toBe(true);
    expect(s.dests.ok.usedAt).toBe(0);
  });

  it("round-trips what rememberRun produced", () => {
    const s = rememberRun(parseSetups(undefined), phone, custom, 5);
    expect(parseSetups(JSON.stringify(s))).toEqual(s);
  });
});

describe("rememberRun", () => {
  it("sets the last setup and the destination entry with its target and date", () => {
    const s = rememberRun(parseSetups(undefined), folderA, custom, 9);
    expect(s.last).toEqual({ ...custom, target: folderA });
    expect(s.dests[destKey(folderA)]).toEqual({ setup: custom, target: folderA, usedAt: 9 });
  });

  it("caps the map at the most recent destinations and never drops the one just run", () => {
    let s = parseSetups(undefined);
    for (let i = 0; i < MAX_DESTS + 5; i++) {
      s = rememberRun(s, { kind: "folder", path: `C:\\d${i}` }, custom, i);
    }
    const keys = Object.keys(s.dests);
    expect(keys).toHaveLength(MAX_DESTS);
    expect(keys).toContain("c:\\d34");
    expect(keys).not.toContain("c:\\d0");

    const tied = rememberRun(s, { kind: "folder", path: "C:\\new" }, custom, 5);
    expect(Object.keys(tied.dests)).toContain("c:\\new");
    expect(Object.keys(tied.dests)).not.toContain("c:\\d5");
    expect(Object.keys(tied.dests)).toHaveLength(MAX_DESTS);
  });
});

describe("rememberPick", () => {
  it("sets the last destination without creating a destination entry", () => {
    const s = rememberPick(parseSetups(undefined), folderA, custom);
    expect(s.last.target).toEqual(folderA);
    expect(s.dests).toEqual({});
  });

  it("refreshes a known destination's reach and keeps its setup and date", () => {
    const ran = rememberRun(parseSetups(undefined), phone, custom, 3);
    const moved: ExportTarget = { kind: "device", target: { ...phone.target, pidl: "bb" } };
    const s = rememberPick(ran, moved, DEFAULT_SETUP);
    expect(s.dests[destKey(phone)]).toEqual({ setup: custom, target: moved, usedAt: 3 });
  });
});

describe("setupFor", () => {
  it("returns the destination's own entry once it has been run", () => {
    const s = rememberRun(parseSetups(undefined), folderA, custom, 1);
    const other = rememberRun(s, folderB, { ...custom, albums: true, scope: "all" }, 2);
    expect(setupFor(other, folderA)).toEqual(custom);
    expect(setupFor(other, { kind: "folder", path: "d:\\MUSIC\\backup" })).toEqual(custom);
  });

  it("gives a new destination the last layout, switches and shape with scope and device mode reset", () => {
    const s = rememberRun(parseSetups(undefined), folderA, custom, 1);
    expect(setupFor(s, folderB)).toEqual({ ...custom, scope: "all", deviceInPlace: false });
  });
});

describe("fitToTarget", () => {
  it("forces a dated device snapshot to all, keeps changed for an in-place device", () => {
    expect(fitToTarget({ ...custom, deviceInPlace: false }, phone).scope).toBe("all");
    expect(fitToTarget(custom, phone).scope).toBe("changed");
  });

  it("clears device mode on a folder and leaves scope alone", () => {
    const fit = fitToTarget(custom, folderA);
    expect(fit.deviceInPlace).toBe(false);
    expect(fit.scope).toBe("changed");
  });
});

describe("setupOnPick", () => {
  it("restores the same destination's setup", () => {
    const s = rememberRun(parseSetups(undefined), folderA, custom, 1);
    expect(setupOnPick(s, folderA, DEFAULT_SETUP)).toEqual({ ...custom, deviceInPlace: false });
  });

  it("keeps the screen's layout, switches and shape for a new destination, scope back to all", () => {
    const s = rememberRun(parseSetups(undefined), folderA, DEFAULT_SETUP, 1);
    const picked = setupOnPick(s, folderB, custom);
    expect(picked).toEqual({ ...custom, scope: "all", deviceInPlace: false });
  });

  it("starts a new device in snapshot mode", () => {
    const s = rememberRun(parseSetups(undefined), folderA, custom, 1);
    const picked = setupOnPick(s, phone, custom);
    expect(picked.deviceInPlace).toBe(false);
    expect(picked.scope).toBe("all");
  });
});

describe("restore", () => {
  it("plans the last destination with its own setup, device mode and scope intact", () => {
    const s = rememberRun(parseSetups(undefined), phone, custom, 1);
    expect(restorePlan(s)).toEqual({ target: phone, setup: custom, recorded: true });
  });

  it("plans no destination from a blob that never held one", () => {
    expect(restorePlan(parseSetups("garbage"))).toEqual({
      target: null,
      setup: DEFAULT_SETUP,
      recorded: false,
    });
  });

  it("applies the layout of a recorded destination that passed its check", () => {
    const plan = restorePlan(rememberRun(parseSetups(undefined), folderA, custom, 1));
    expect(settleRestore(plan, true)).toEqual({
      target: folderA,
      setup: { ...custom, deviceInPlace: false },
      applyLayout: true,
    });
  });

  it("restores a picked but never run destination without a layout write", () => {
    const picked = rememberPick(parseSetups(undefined), folderA, custom);
    const plan = restorePlan(picked);
    expect(plan.recorded).toBe(false);
    const settled = settleRestore(plan, true);
    expect(settled.target).toEqual(folderA);
    expect(settled.applyLayout).toBe(false);
  });

  it("applies no layout when there is no destination to restore", () => {
    expect(settleRestore(restorePlan(parseSetups(undefined)), true).applyLayout).toBe(false);
  });

  it("leaves the destination empty on a failed check, keeps the rest and applies no layout", () => {
    const plan = restorePlan(rememberRun(parseSetups(undefined), folderA, custom, 1));
    const settled = settleRestore(plan, false);
    expect(settled.target).toBeNull();
    expect(settled.applyLayout).toBe(false);
    expect(settled.setup).toEqual({ ...custom, scope: "all", deviceInPlace: false });
  });
});

describe("hostile blobs", () => {
  it("skips a __proto__ destination key without touching the map's prototype", () => {
    const raw = `{"dests":{"__proto__":{"setup":{"albums":false},"target":{"kind":"folder","path":"C:\\\\x"},"usedAt":1}}}`;
    const s = parseSetups(raw);
    expect(Object.keys(s.dests)).toEqual([]);
    expect(Object.getPrototypeOf(s.dests)).toBe(Object.prototype);
    expect(hasRecord(s, { kind: "folder", path: "__proto__" })).toBe(false);
  });

  it("reads no record for an inherited key", () => {
    expect(hasRecord(parseSetups(undefined), { kind: "folder", path: "constructor" })).toBe(false);
  });

  it("treats a dests array as empty", () => {
    expect(parseSetups(JSON.stringify({ dests: [{ target: folderA }] })).dests).toEqual({});
  });

  it("caps a stored map of 500 entries, keeping the most recent", () => {
    const dests: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      dests[`c:\\d${i}`] = { setup: {}, target: { kind: "folder", path: `C:\\d${i}` }, usedAt: i };
    }
    const keys = Object.keys(parseSetups(JSON.stringify({ dests })).dests);
    expect(keys).toHaveLength(MAX_DESTS);
    expect(keys).toContain("c:\\d499");
    expect(keys).not.toContain("c:\\d469");
  });
});
