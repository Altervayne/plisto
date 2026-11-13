// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { enabledOf, usePluginsStore } from "./store";
import { row } from "./fixtures";

const state = () => usePluginsStore.getState();

beforeEach(() => {
  usePluginsStore.setState({ rows: [], boot: null, status: "idle" });
});

describe("upsertRow", () => {
  it("appends a new id and replaces a known one in place", () => {
    state().upsertRow(row({ id: "a" }));
    state().upsertRow(row({ id: "b" }));
    state().upsertRow(row({ id: "a", enabled: false }));
    expect(state().rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(state().rows[0].enabled).toBe(false);
  });

  it("keeps the rows array when the row is unchanged", () => {
    state().upsertRow(row({ id: "a" }));
    const before = state().rows;
    state().upsertRow(row({ id: "a" }));
    expect(state().rows).toBe(before);
  });

  it("keeps the other rows' objects", () => {
    state().upsertRow(row({ id: "a" }));
    state().upsertRow(row({ id: "b" }));
    const a = state().rows[0];
    state().upsertRow(row({ id: "b", enabled: false }));
    expect(state().rows[0]).toBe(a);
  });

  it("moves the enabled slice when the enabled set changes", () => {
    state().upsertRow(row({ id: "a", enabled: false }));
    expect(enabledOf(state().rows)).toEqual([]);
    state().upsertRow(row({ id: "a", enabled: true }));
    expect(enabledOf(state().rows)).toHaveLength(1);
  });
});

describe("epoch", () => {
  it("is bumped by every local row change and not by a listing", () => {
    const start = state().epoch;
    state().upsertRow(row({ id: "a" }));
    state().removeRow("a");
    expect(state().epoch).toBe(start + 2);
    state().applyRows([row({ id: "b" })]);
    expect(state().epoch).toBe(start + 2);
  });
});

describe("removeRow", () => {
  it("drops the row", () => {
    state().upsertRow(row({ id: "a" }));
    state().upsertRow(row({ id: "b" }));
    state().removeRow("a");
    expect(state().rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("leaves the array alone for an unknown id", () => {
    state().upsertRow(row({ id: "a" }));
    const before = state().rows;
    state().removeRow("zzz");
    expect(state().rows).toBe(before);
  });
});
