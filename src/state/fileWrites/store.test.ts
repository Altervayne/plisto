// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ stampEnabled: true }));
vi.mock("../../lib/features", () => ({
  get STAMP_ENABLED() {
    return flags.stampEnabled;
  },
}));

// -- Unit Imports --
import { hasRecoveryNews, openKeptBackups, openStampSheet, openStampUndo, useFileWritesStore } from "./store";

const state = () => useFileWritesStore.getState();

beforeEach(() => {
  useFileWritesStore.setState({ sheet: null, recovery: null, running: null });
});

describe("sheets", () => {
  it("opens the stamp sheet over its scope and the kept list, and closes either", () => {
    openStampSheet({ kind: "albums", albumIds: [3] });
    expect(state().sheet).toEqual({ kind: "stamp", scope: { kind: "albums", albumIds: [3] } });
    openKeptBackups();
    expect(state().sheet).toEqual({ kind: "kept" });
    state().closeSheet();
    expect(state().sheet).toBeNull();
  });

  it("opens no tag-write sheet while the feature is off", () => {
    flags.stampEnabled = false;
    openStampSheet({ kind: "library" });
    openStampUndo(4);
    expect(state().sheet).toBeNull();
    flags.stampEnabled = true;
  });
});

describe("recovery", () => {
  it("shows nothing for a null or an empty report", () => {
    state().showRecovery(null);
    state().showRecovery({ restored: 0, finished: 0, heldOffline: 0, needsAttention: [] });
    expect(state().recovery).toBeNull();
    expect(hasRecoveryNews(null)).toBe(false);
  });

  it("keeps a report until it is dismissed", () => {
    state().showRecovery({ restored: 1, finished: 0, heldOffline: 0, needsAttention: [] });
    expect(state().recovery?.restored).toBe(1);
    state().dismissRecovery();
    expect(state().recovery).toBeNull();
  });

  it("adds a later report to the one showing, with the latest offline count", () => {
    state().showRecovery({ restored: 1, finished: 1, heldOffline: 3, needsAttention: ["a.opus"] });
    state().showRecovery({ restored: 2, finished: 0, heldOffline: 2, needsAttention: ["a.opus", "b.opus"] });
    expect(state().recovery).toEqual({
      restored: 3,
      finished: 1,
      heldOffline: 2,
      needsAttention: ["a.opus", "b.opus"],
    });
  });

  it("counts a report with only files needing a look as news", () => {
    expect(hasRecoveryNews({ restored: 0, finished: 0, heldOffline: 0, needsAttention: ["x"] })).toBe(true);
  });
});

describe("running batch", () => {
  it("tracks progress and clears at the end", () => {
    state().startRun("stamp", 6);
    state().setRunDone(4);
    expect(state().running).toEqual({ kind: "stamp", done: 4, total: 6 });
    state().endRun();
    expect(state().running).toBeNull();
  });

  it("ignores progress with no batch running", () => {
    state().setRunDone(2);
    expect(state().running).toBeNull();
  });
});
