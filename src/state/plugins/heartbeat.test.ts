// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { CRASH_MS, NOT_RESPONDING_MS, hide, pong, show, start, tick, wait } from "./heartbeat";

describe("heartbeat", () => {
  it("starts loading with the clock at mount", () => {
    const hb = start(100);
    expect(hb).toMatchObject({ phase: "loading", lastAlive: 100, seq: 0, everAlive: false, paused: false });
  });

  it("emits pings only once loaded, counting from 1", () => {
    let hb = start(0);
    let r = tick(hb, 1000, false);
    expect(r.ping).toBeNull();
    expect(r.hb.seq).toBe(0);
    r = tick(r.hb, 2000, true);
    expect(r.ping).toBe(1);
    r = tick(r.hb, 3000, true);
    expect(r.ping).toBe(2);
    hb = r.hb;
    expect(hb.seq).toBe(2);
  });

  it("goes live on a pong for a sent ping", () => {
    let hb = tick(start(0), 1000, true).hb;
    hb = pong(hb, 1, 1100);
    expect(hb).toMatchObject({ phase: "live", everAlive: true, lastAlive: 1100, lastPongSeq: 1 });
  });

  it("ignores out-of-range and repeated pongs", () => {
    let hb = tick(start(0), 1000, true).hb;
    expect(pong(hb, 2, 1100)).toBe(hb);
    expect(pong(hb, 0, 1100)).toBe(hb);
    hb = pong(hb, 1, 1100);
    expect(pong(hb, 1, 1200)).toBe(hb);
  });

  it("reads not responding at 5 s of silence and crashed at 15 s", () => {
    let hb = start(0);
    hb = tick(hb, NOT_RESPONDING_MS - 1, true).hb;
    expect(hb.phase).toBe("loading");
    hb = tick(hb, NOT_RESPONDING_MS, true).hb;
    expect(hb.phase).toBe("not_responding");
    hb = tick(hb, CRASH_MS - 1, true).hb;
    expect(hb.phase).toBe("not_responding");
    const last = tick(hb, CRASH_MS, true);
    expect(last.hb.phase).toBe("crashed");
    expect(last.ping).toBeNull();
  });

  it("crashes a frame whose load never completes", () => {
    expect(tick(start(0), CRASH_MS, false).hb.phase).toBe("crashed");
  });

  it("recovers from not responding on a pong", () => {
    let hb = tick(start(0), 1000, true).hb;
    hb = tick(hb, 6000, true).hb;
    expect(hb.phase).toBe("not_responding");
    hb = pong(hb, hb.seq, 6100);
    expect(hb.phase).toBe("live");
  });

  it("does nothing once crashed", () => {
    const crashed = tick(start(0), CRASH_MS, true).hb;
    const r = tick(crashed, CRASH_MS + 5000, true);
    expect(r.hb).toBe(crashed);
    expect(r.ping).toBeNull();
    expect(pong(crashed, 1, CRASH_MS + 1)).toBe(crashed);
    expect(wait(crashed, CRASH_MS + 1)).toBe(crashed);
  });

  it("freezes the clock while hidden and grants grace on show", () => {
    let hb = hide(start(0));
    const r = tick(hb, 60000, true);
    expect(r.hb).toBe(hb);
    expect(r.ping).toBeNull();
    hb = show(hb, 60000);
    expect(hb.paused).toBe(false);
    expect(tick(hb, 62000, true).hb.phase).toBe("loading");
    expect(tick(hb, 60000 + NOT_RESPONDING_MS, true).hb.phase).toBe("not_responding");
  });

  it("restarts both clocks on wait", () => {
    let hb = tick(start(0), 1000, true).hb;
    hb = pong(hb, 1, 1000);
    hb = tick(hb, 7000, true).hb;
    expect(hb.phase).toBe("not_responding");
    hb = wait(hb, 7000);
    expect(hb).toMatchObject({ phase: "live", lastAlive: 7000 });
    expect(tick(hb, 11999, true).hb.phase).toBe("live");
    expect(tick(hb, 12000, true).hb.phase).toBe("not_responding");
    expect(tick(hb, 7000 + CRASH_MS, true).hb.phase).toBe("crashed");
  });

  it("returns a never-live frame to loading on wait", () => {
    let hb = tick(start(0), 6000, false).hb;
    expect(hb.phase).toBe("not_responding");
    hb = wait(hb, 6000);
    expect(hb.phase).toBe("loading");
  });
});
