// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useSidebarState } from "./sidebarState";
import { useFrameHealthStore } from "./frameHealth";
import { APPEARANCE_MS, COALESCE_MS, TOGGLE_PENDING_MS } from "./sidebarModel";

// -- Type Imports --
import type { PluginItemState, PluginSidebarEvent } from "../../types";

const KEY_A = "a|1.0.0|h";
const state = () => useSidebarState.getState();

const toggle = (on: boolean): PluginItemState => ({ type: "toggle", visible: true, on, enabled: true });
const status = (text: string): PluginItemState => ({ type: "status", visible: true, tone: "neutral", text });
const itemEvent = (id: string, itemId: string, s: PluginItemState): PluginSidebarEvent => ({
  id,
  kind: "item",
  item_id: itemId,
  state: s,
});
const chipsEvent = (id: string, text: string): PluginSidebarEvent => ({
  id,
  kind: "chips",
  chips: [{ text, count: null, tone: "neutral" }],
});

beforeEach(() => {
  vi.useFakeTimers();
  useFrameHealthStore.setState({ health: {}, crashed: new Set(), generation: {} });
});

afterEach(() => {
  for (const id of Object.keys(state().byPlugin)) state().drop(id);
  for (const key of Object.keys(state().pending)) {
    const [id, item] = key.split("|");
    state().clearPending(id, item);
  }
  useSidebarState.setState({ byPlugin: {}, pending: {} });
  vi.useRealTimers();
});

describe("events", () => {
  it("draws the first change at once and lands a burst once, with the last value", () => {
    state().applyEvent(itemEvent("a", "s", status("one")), KEY_A);
    expect(state().byPlugin.a.items.s).toEqual(status("one"));
    vi.advanceTimersByTime(100);
    state().applyEvent(itemEvent("a", "s", status("two")), KEY_A);
    state().applyEvent(itemEvent("a", "s", status("three")), KEY_A);
    expect(state().byPlugin.a.items.s).toEqual(status("one"));
    vi.advanceTimersByTime(COALESCE_MS - 101);
    expect(state().byPlugin.a.items.s).toEqual(status("one"));
    vi.advanceTimersByTime(1);
    expect(state().byPlugin.a.items.s).toEqual(status("three"));
  });

  it("keeps chips and items of one plugin apart", () => {
    state().applyEvent(itemEvent("a", "s", status("one")), KEY_A);
    state().applyEvent(chipsEvent("a", "3"), KEY_A);
    expect(state().byPlugin.a.chips).toEqual([{ text: "3", count: null, tone: "neutral" }]);
    expect(state().byPlugin.a.items.s).toEqual(status("one"));
  });

  it("ignores events for a plugin whose frame crashed", () => {
    useFrameHealthStore.setState({ health: { a: { phase: "crashed", reason: "silent" } } });
    state().applyEvent(itemEvent("a", "s", status("one")), KEY_A);
    expect(state().byPlugin.a).toBeUndefined();
  });

  it("starts over when the plugin's crash key changed", () => {
    state().applyEvent(itemEvent("a", "s", status("one")), KEY_A);
    vi.advanceTimersByTime(COALESCE_MS);
    state().applyEvent(itemEvent("a", "t", status("two")), "a|2.0.0|h");
    expect(state().byPlugin.a).toEqual({ key: "a|2.0.0|h", chips: [], items: { t: status("two") } });
  });
});

describe("appearance pacing", () => {
  const tone = (t: "neutral" | "warn"): PluginItemState => ({ type: "status", visible: true, tone: t, text: "x" });

  it("holds a tone change for APPEARANCE_MS and lands the latest value once", () => {
    state().applyEvent(itemEvent("a", "s", tone("neutral")), KEY_A);
    vi.advanceTimersByTime(COALESCE_MS);
    state().applyEvent(itemEvent("a", "s", tone("warn")), KEY_A);
    vi.advanceTimersByTime(APPEARANCE_MS - COALESCE_MS - 1);
    expect(state().byPlugin.a.items.s).toEqual(tone("neutral"));
    vi.advanceTimersByTime(1);
    expect(state().byPlugin.a.items.s).toEqual(tone("warn"));
  });

  it("draws a pending toggle's answer at the content pace", () => {
    state().applyEvent(itemEvent("a", "auto", toggle(false)), KEY_A);
    vi.advanceTimersByTime(100);
    state().setPending("a", "auto");
    state().applyEvent(itemEvent("a", "auto", toggle(true)), KEY_A);
    vi.advanceTimersByTime(COALESCE_MS - 100);
    expect(state().byPlugin.a.items.auto).toEqual(toggle(true));
    expect(state().pending).toEqual({});
  });

  it("drops a held appearance change on drop, and its timer draws nothing", () => {
    state().applyEvent(itemEvent("a", "s", tone("neutral")), KEY_A);
    state().applyEvent(itemEvent("a", "s", tone("warn")), KEY_A);
    state().drop("a");
    vi.advanceTimersByTime(APPEARANCE_MS * 2);
    expect(state().byPlugin.a).toBeUndefined();
  });

  it("does not draw a held change for a plugin that crashed meanwhile", () => {
    state().applyEvent(itemEvent("a", "s", tone("neutral")), KEY_A);
    state().applyEvent(itemEvent("a", "s", tone("warn")), KEY_A);
    useFrameHealthStore.setState({ health: { a: { phase: "crashed", reason: "silent" } } });
    vi.advanceTimersByTime(APPEARANCE_MS);
    expect(state().byPlugin.a.items.s).toEqual(tone("neutral"));
  });
});

describe("snapshot", () => {
  it("replaces the entries and skips ids without a key", () => {
    state().applyEvent(itemEvent("old", "s", status("x")), "old|1|h");
    state().applySnapshot(
      [
        { id: "a", chips: [], items: [{ item_id: "s", state: status("boot") }] },
        { id: "gone", chips: [], items: [] },
      ],
      new Map([["a", KEY_A]]),
    );
    expect(Object.keys(state().byPlugin)).toEqual(["a"]);
    expect(state().byPlugin.a.items.s).toEqual(status("boot"));
  });
});

describe("drop and prune", () => {
  it("prunes every plugin whose crash key is not its live row's", () => {
    state().applyEvent(itemEvent("a", "s", status("one")), KEY_A);
    state().applyEvent(itemEvent("b", "s", status("one")), "b|1|h");
    state().applyEvent(itemEvent("c", "s", status("one")), "c|1|h");
    state().prune(
      new Map([
        ["a", KEY_A],
        ["b", "b|2|h"],
      ]),
    );
    expect(Object.keys(state().byPlugin)).toEqual(["a"]);
  });

  it("drop cancels a held value, so it never lands", () => {
    state().applyEvent(itemEvent("a", "s", status("one")), KEY_A);
    state().applyEvent(itemEvent("a", "s", status("two")), KEY_A);
    state().drop("a");
    vi.advanceTimersByTime(COALESCE_MS);
    expect(state().byPlugin.a).toBeUndefined();
  });

  it("keeps the store object when there is nothing to drop", () => {
    const before = state();
    state().drop("missing");
    expect(state().byPlugin).toBe(before.byPlugin);
  });
});

describe("toggle pending", () => {
  it("ends on the next item event for that item", () => {
    state().setPending("a", "auto");
    expect("a|auto" in state().pending).toBe(true);
    state().applyEvent(itemEvent("a", "other", toggle(true)), KEY_A);
    expect("a|auto" in state().pending).toBe(true);
    state().applyEvent(itemEvent("a", "auto", toggle(false)), KEY_A);
    expect(state().pending).toEqual({});
    expect(state().byPlugin.a.items.auto).toEqual(toggle(false));
  });

  it("ends when a held confirming update lands", () => {
    state().applyEvent(itemEvent("a", "auto", toggle(false)), KEY_A);
    state().setPending("a", "auto");
    state().applyEvent(itemEvent("a", "auto", toggle(true)), KEY_A);
    expect("a|auto" in state().pending).toBe(true);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(state().pending).toEqual({});
    expect(state().byPlugin.a.items.auto).toEqual(toggle(true));
  });

  it("ends at the deadline without an event", () => {
    state().setPending("a", "auto");
    vi.advanceTimersByTime(TOGGLE_PENDING_MS - 1);
    expect("a|auto" in state().pending).toBe(true);
    vi.advanceTimersByTime(1);
    expect(state().pending).toEqual({});
  });

  it("a second press restarts the deadline", () => {
    state().setPending("a", "auto");
    vi.advanceTimersByTime(2000);
    state().setPending("a", "auto");
    vi.advanceTimersByTime(2000);
    expect("a|auto" in state().pending).toBe(true);
    vi.advanceTimersByTime(TOGGLE_PENDING_MS - 2000);
    expect(state().pending).toEqual({});
  });
});
