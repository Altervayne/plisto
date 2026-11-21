// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { FULL_VISIBLE, fullyVisible, NEVER_FIT, SCROLLED_OUT, SlotWatch } from "./slotWatch";
import type { ObserverFactory, VisibilityEntry } from "./slotWatch";

function harness() {
  let report: (entries: VisibilityEntry[]) => void = () => {};
  let disconnected = false;
  const make: ObserverFactory = (onEntries) => {
    report = onEntries;
    return { disconnect: () => (disconnected = true) };
  };
  return {
    watch: new SlotWatch({} as Element, make),
    send: (ratio: number, isIntersecting = ratio > 0) => report([{ isIntersecting, intersectionRatio: ratio }]),
    disconnected: () => disconnected,
  };
}

describe("fullyVisible", () => {
  it("accepts a slot at the full threshold and refuses one below it", () => {
    expect(fullyVisible({ isIntersecting: true, intersectionRatio: 1 })).toBe(true);
    expect(fullyVisible({ isIntersecting: true, intersectionRatio: FULL_VISIBLE })).toBe(true);
    expect(fullyVisible({ isIntersecting: true, intersectionRatio: 0.5 })).toBe(false);
    expect(fullyVisible({ isIntersecting: false, intersectionRatio: 0 })).toBe(false);
  });
});

describe("SlotWatch", () => {
  it("stays quiet while every report shows the slot in view", () => {
    const h = harness();
    h.send(1);
    h.send(1);
    expect(h.watch.leftView).toBe(false);
  });

  it("remembers a departure even after the slot comes back", () => {
    const h = harness();
    h.send(1);
    h.send(0.4);
    h.send(1);
    expect(h.watch.leftView).toBe(true);
  });

  it("reads a slot that never showed in full as too small, not scrolled out", () => {
    const h = harness();
    h.send(0.6);
    h.send(0.5);
    expect(h.watch.leftView).toBe(true);
    expect(h.watch.note).toBe(NEVER_FIT);
  });

  it("reads a slot that showed in full and then left as scrolled out", () => {
    const h = harness();
    h.send(1);
    h.send(0.4);
    expect(h.watch.note).toBe(SCROLLED_OUT);
  });

  it("takes a departure still queued when it stops", () => {
    let disconnected = false;
    const make: ObserverFactory = (onEntries) => {
      onEntries([{ isIntersecting: true, intersectionRatio: 1 }]);
      return {
        takeRecords: () => [{ isIntersecting: false, intersectionRatio: 0 }],
        disconnect: () => (disconnected = true),
      };
    };
    const watch = new SlotWatch({} as Element, make);
    expect(watch.leftView).toBe(false);
    watch.stop();
    expect(watch.leftView).toBe(true);
    expect(watch.note).toBe(SCROLLED_OUT);
    expect(disconnected).toBe(true);
  });

  it("disconnects its observer on stop", () => {
    const h = harness();
    h.watch.stop();
    expect(h.disconnected()).toBe(true);
  });
});
