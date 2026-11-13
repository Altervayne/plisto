// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { APPEARANCE_MS, COALESCE_MS, appearanceSig, chipsKey, coalesce, flush, itemKey, itemView } from "./sidebarModel";

// -- Type Imports --
import type { CoalesceState } from "./sidebarModel";
import type { PluginChip, PluginItemState, PluginSidebarEvent, PluginSidebarItem, PluginTone } from "../../types";

const decl = (type: PluginSidebarItem["type"]): PluginSidebarItem => ({
  id: "it",
  type,
  label: "Declared",
  route: null,
  icon: null,
});

describe("coalesce", () => {
  const empty: CoalesceState<number> = {};

  it("shows the first change at once", () => {
    const step = coalesce(empty, { key: "p|a", value: 1 }, 1000);
    expect(step.show).toBe(1);
    expect(step.flushAt).toBeNull();
  });

  it("holds a change inside the window and flushes it at the trailing edge", () => {
    const first = coalesce(empty, { key: "p|a", value: 1 }, 1000);
    const second = coalesce(first.state, { key: "p|a", value: 2 }, 1100);
    expect(second.show).toBeNull();
    expect(second.flushAt).toBe(1000 + COALESCE_MS);
    const flushed = flush(second.state, "p|a", 1500);
    expect(flushed.show).toBe(2);
  });

  it("lands a burst once, with the last value", () => {
    let step = coalesce(empty, { key: "p|a", value: 1 }, 0);
    for (const [value, at] of [[2, 50], [3, 120], [4, 300], [5, 499]] as const) {
      step = coalesce(step.state, { key: "p|a", value }, at);
      expect(step.show).toBeNull();
      expect(step.flushAt).toBe(COALESCE_MS);
    }
    const flushed = flush(step.state, "p|a", COALESCE_MS);
    expect(flushed.show).toBe(5);
    expect(flush(flushed.state, "p|a", COALESCE_MS + 1).show).toBeNull();
  });

  it("shows at once again after a quiet window", () => {
    const first = coalesce(empty, { key: "p|a", value: 1 }, 0);
    const later = coalesce(first.state, { key: "p|a", value: 2 }, COALESCE_MS);
    expect(later.show).toBe(2);
  });

  it("measures the next window from the flush", () => {
    const first = coalesce(empty, { key: "p|a", value: 1 }, 0);
    const held = coalesce(first.state, { key: "p|a", value: 2 }, 10);
    const flushed = flush(held.state, "p|a", 500);
    const next = coalesce(flushed.state, { key: "p|a", value: 3 }, 600);
    expect(next.show).toBeNull();
    expect(next.flushAt).toBe(500 + COALESCE_MS);
  });

  it("keeps separate keys independent", () => {
    const first = coalesce(empty, { key: itemKey("p", "a"), value: 1 }, 0);
    const other = coalesce(first.state, { key: itemKey("p", "b"), value: 9 }, 10);
    expect(other.show).toBe(9);
    const chips = coalesce(other.state, { key: chipsKey("p"), value: 7 }, 20);
    expect(chips.show).toBe(7);
    const again = coalesce(chips.state, { key: itemKey("p", "a"), value: 2 }, 30);
    expect(again.show).toBeNull();
  });

  it("flush on a key with nothing held changes nothing", () => {
    const first = coalesce(empty, { key: "p|a", value: 1 }, 0);
    const flushed = flush(first.state, "p|a", 600);
    expect(flushed.show).toBeNull();
    expect(flushed.state).toBe(first.state);
    expect(flush(first.state, "missing", 600).show).toBeNull();
  });
});

describe("appearance pacing", () => {
  const item = (state: PluginItemState): PluginSidebarEvent => ({ id: "p", kind: "item", item_id: "i", state });
  const chips = (list: PluginChip[]): PluginSidebarEvent => ({ id: "p", kind: "chips", chips: list });
  const status = (tone: PluginTone, text = "t"): PluginItemState => ({ type: "status", visible: true, tone, text });
  const progress = (value: number | null): PluginItemState => ({ type: "progress", visible: true, value, text: null });
  const toggle = (on: boolean): PluginItemState => ({ type: "toggle", visible: true, on, enabled: true });
  const chip = (text: string, tone: PluginTone = "neutral", count: number | null = null): PluginChip => ({
    text,
    count,
    tone,
  });

  /** Feeds events at the given times, flushing at each held edge; returns the draw times and values. */
  function run(events: [number, PluginSidebarEvent][], quick: (at: number) => boolean = () => false) {
    let state: CoalesceState<PluginSidebarEvent> = {};
    const drawn: [number, PluginSidebarEvent][] = [];
    let due: number | null = null;
    const release = (upTo: number) => {
      if (due != null && due <= upTo) {
        const step = flush(state, "k", due);
        state = step.state;
        if (step.show) drawn.push([due, step.show]);
        due = null;
      }
    };
    for (const [at, event] of events) {
      release(at);
      const step = coalesce(state, { key: "k", value: event, appearance: appearanceSig(event), quick: quick(at) }, at);
      state = step.state;
      if (step.show) drawn.push([at, step.show]);
      due = step.flushAt ?? (step.show ? null : due);
    }
    release(Infinity);
    return drawn;
  }

  it("holds a tone that alternates every 500 ms to one change per 2000 ms and ends on the latest", () => {
    const events: [number, PluginSidebarEvent][] = [];
    for (let i = 0; i < 12; i++) events.push([i * COALESCE_MS, item(status(i % 2 ? "neutral" : "warn"))]);
    const drawn = run(events);
    const toneChanges = drawn.filter(([, e], i) => i === 0 || appearanceSig(e) !== appearanceSig(drawn[i - 1][1]));
    for (let i = 1; i < toneChanges.length; i++) {
      expect(toneChanges[i][0] - toneChanges[i - 1][0]).toBeGreaterThanOrEqual(APPEARANCE_MS);
    }
    expect(drawn[drawn.length - 1][1]).toBe(events[events.length - 1][1]);
  });

  it("draws text-only updates every 500 ms as before", () => {
    const events: [number, PluginSidebarEvent][] = [];
    for (let i = 0; i < 6; i++) events.push([i * COALESCE_MS, item(status("warn", `n${i}`))]);
    expect(run(events).map(([at]) => at)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });

  it("holds a visible true/false alternation", () => {
    const vis = (visible: boolean) => item({ ...status("neutral"), visible });
    const drawn = run([0, 500, 1000, 1500, 2000].map((at, i) => [at, vis(i % 2 === 0)] as [number, PluginSidebarEvent]));
    const flips = drawn.filter(([, e], i) => i === 0 || appearanceSig(e) !== appearanceSig(drawn[i - 1][1]));
    expect(flips.map(([at]) => at)).toEqual([0, 2000, 4000]);
  });

  it("holds a toggle's fill, whole, and lets the latest replace it", () => {
    const first = coalesce({}, { key: "k", value: 1, appearance: appearanceSig(item(toggle(true))) }, 0);
    const held = coalesce(first.state, { key: "k", value: 2, appearance: appearanceSig(item(toggle(false))) }, 600);
    expect(held.show).toBeNull();
    expect(held.flushAt).toBe(APPEARANCE_MS);
    const later = coalesce(held.state, { key: "k", value: 3, appearance: appearanceSig(item(toggle(false))) }, 900);
    expect(later.flushAt).toBe(APPEARANCE_MS);
    expect(flush(later.state, "k", APPEARANCE_MS).show).toBe(3);
  });

  it("holds chips that change tone or count, not chips that change text", () => {
    const toneFlip = run([[0, chips([chip("a")])], [500, chips([chip("a", "warn")])], [1000, chips([chip("a")])]]);
    expect(toneFlip.map(([at]) => at)).toEqual([0, 1000]);
    const countFlip = run([[0, chips([chip("a")])], [500, chips([chip("a"), chip("b")])]]);
    expect(countFlip.map(([at]) => at)).toEqual([0, 2000]);
    const textOnly = run([[0, chips([chip("a")])], [500, chips([chip("b", "neutral", 3)])]]);
    expect(textOnly.map(([at]) => at)).toEqual([0, 500]);
  });

  it("holds a flip between sweep and value, not determinate values", () => {
    const flip = run([[0, item(progress(0.2))], [500, item(progress(null))]]);
    expect(flip.map(([at]) => at)).toEqual([0, 2000]);
    const values = run([[0, item(progress(0.2))], [500, item(progress(0.4))], [1000, item(progress(0.6))]]);
    expect(values.map(([at]) => at)).toEqual([0, 500, 1000]);
  });

  it("does not hold a quick (pending) answer, and still counts it as an appearance change", () => {
    const drawn = run([[0, item(toggle(true))], [100, item(toggle(false))], [700, item(toggle(true))]], (at) => at === 100);
    expect(drawn.map(([at]) => at)).toEqual([0, 500, 2500]);
  });

  it("draws the first state at once whatever its appearance", () => {
    const step = coalesce({}, { key: "k", value: 1, appearance: appearanceSig(item(status("warn"))) }, 5);
    expect(step.show).toBe(1);
  });

  it("moves the due time down when a content-only value replaces a held appearance change", () => {
    const base = appearanceSig(item(status("neutral")));
    const first = coalesce({}, { key: "k", value: 1, appearance: base }, 0);
    const held = coalesce(first.state, { key: "k", value: 2, appearance: appearanceSig(item(status("warn"))) }, 100);
    expect(held.flushAt).toBe(APPEARANCE_MS);
    const back = coalesce(held.state, { key: "k", value: 3, appearance: base }, 200);
    expect(back.show).toBeNull();
    expect(back.flushAt).toBe(COALESCE_MS);
  });
});

describe("itemView", () => {
  const nav: PluginItemState = { type: "nav", visible: true, label: null, chip: null };
  const status: PluginItemState = { type: "status", visible: true, tone: "warn", text: "Count 20" };
  const progress: PluginItemState = { type: "progress", visible: true, value: 0.4, text: null };
  const toggle: PluginItemState = { type: "toggle", visible: true, on: true, enabled: true };
  const action: PluginItemState = { type: "action", visible: true, label: null, enabled: true };

  it("rests without live state", () => {
    for (const type of ["nav", "status", "progress", "toggle", "action"] as const) {
      expect(itemView(decl(type), undefined, "loading", false)).toEqual({ kind: "rest" });
    }
    expect(itemView(decl("toggle"), undefined, "live", false)).toEqual({ kind: "rest" });
    expect(itemView(decl("status"), undefined, undefined, false)).toEqual({ kind: "rest" });
  });

  it("makes an action clickable by default once the plugin is live", () => {
    expect(itemView(decl("action"), undefined, "live", false)).toEqual({
      kind: "action",
      label: "Declared",
      enabled: true,
    });
    expect(itemView(decl("action"), undefined, "loading", false)).toEqual({ kind: "rest" });
    expect(itemView(decl("action"), undefined, "not_responding", false)).toEqual({ kind: "rest" });
  });

  it("draws each live type", () => {
    expect(itemView(decl("nav"), nav, "live", false)).toEqual({ kind: "nav", label: "Declared", chip: null });
    const chip = { text: "2", count: null, tone: "accent" as const };
    expect(itemView(decl("nav"), { ...nav, label: "Own", chip }, "live", false)).toEqual({
      kind: "nav",
      label: "Own",
      chip,
    });
    expect(itemView(decl("status"), status, "live", false)).toEqual({
      kind: "status",
      tone: "warn",
      text: "Count 20",
    });
    expect(itemView(decl("progress"), progress, "live", false)).toEqual({
      kind: "progress",
      value: 0.4,
      text: null,
    });
    expect(itemView(decl("toggle"), toggle, "live", false)).toEqual({
      kind: "toggle",
      on: true,
      enabled: true,
      pending: false,
    });
    expect(itemView(decl("action"), { ...action, label: "Go" }, "live", false)).toEqual({
      kind: "action",
      label: "Go",
      enabled: true,
    });
  });

  it("carries the pending flag on a toggle without moving it", () => {
    expect(itemView(decl("toggle"), toggle, "live", true)).toEqual({
      kind: "toggle",
      on: true,
      enabled: true,
      pending: true,
    });
  });

  it("honors the plugin's own disabled flag", () => {
    expect(itemView(decl("toggle"), { ...toggle, enabled: false }, "live", false)).toMatchObject({ enabled: false });
    expect(itemView(decl("action"), { ...action, enabled: false }, "live", false)).toMatchObject({ enabled: false });
  });

  it("disables toggle and action while not responding, and keeps status and progress", () => {
    expect(itemView(decl("toggle"), toggle, "not_responding", false)).toMatchObject({ kind: "toggle", on: true, enabled: false });
    expect(itemView(decl("action"), action, "not_responding", false)).toMatchObject({ kind: "action", enabled: false });
    expect(itemView(decl("status"), status, "not_responding", false)).toMatchObject({ kind: "status", text: "Count 20" });
    expect(itemView(decl("progress"), progress, "not_responding", false)).toMatchObject({ kind: "progress", value: 0.4 });
  });

  it("hides an item the plugin hid", () => {
    expect(itemView(decl("status"), { ...status, visible: false }, "live", false)).toEqual({ kind: "hidden" });
    expect(itemView(decl("nav"), { ...nav, visible: false }, "not_responding", false)).toEqual({ kind: "hidden" });
  });

  it("rests for a crashed plugin and for state of another type", () => {
    expect(itemView(decl("status"), status, "crashed", false)).toEqual({ kind: "rest" });
    expect(itemView(decl("toggle"), status, "live", false)).toEqual({ kind: "rest" });
  });
});
