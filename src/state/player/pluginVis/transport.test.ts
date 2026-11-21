import { describe, expect, it } from "vitest";
import { TICK_CREDITS, type HostMessage, type Tick } from "../../../visRuntime/protocol";
import { restSignal } from "../visualSignal";
import { createTransport, type HostPort } from "./transport";

function tick(seq: number, over: Partial<Tick> = {}): Tick {
  return {
    seq,
    t: seq / 30,
    dt: 1 / 30,
    sig: restSignal(),
    nBeats: 0,
    beatAt: null,
    rawBands: [],
    fine: null,
    playing: true,
    trackSeq: 0,
    progress: null,
    pointer: null,
    wave: null,
    ...over,
  };
}

function setup(visible = true) {
  const posted: HostMessage[] = [];
  const port: HostPort = { postMessage: (m) => posted.push(m), close: () => {}, onmessage: null };
  const state = { visible, clock: 0 };
  const transport = createTransport({
    port,
    isVisible: () => state.visible,
    now: () => state.clock,
  });
  const ticks = () => posted.filter((m): m is Extract<HostMessage, { type: "tick" }> => m.type === "tick");
  const ack = (seq: number, ms: number | null = 1) => port.onmessage?.({ data: { type: "ack", seq, ms } });
  return { transport, state, port, posted, ticks, ack };
}

describe("createTransport", () => {
  it("never has more than the credit window in flight", () => {
    const s = setup();
    for (let i = 1; i <= 10; i++) {
      s.transport.offer(tick(i));
      expect(s.transport.stats().outstanding).toBeLessThanOrEqual(TICK_CREDITS);
    }
    expect(s.ticks().map((t) => t.seq)).toEqual([1, 2]);
    s.ack(2);
    expect(s.transport.stats().outstanding).toBeLessThanOrEqual(TICK_CREDITS);
    expect(s.ticks().map((t) => t.seq)).toEqual([1, 2, 10]);
  });

  it("folds the ticks that waited for credit into one", () => {
    const s = setup();
    for (let i = 1; i <= 5; i++) s.transport.offer(tick(i, { nBeats: 1 }));
    s.ack(2);
    const held = s.ticks()[2];
    expect(held.seq).toBe(5);
    expect(held.nBeats).toBe(3);
    expect(held.dt).toBeCloseTo(3 / 30);
  });

  it("sends nothing while hidden", () => {
    const s = setup(false);
    for (let i = 1; i <= 5; i++) s.transport.offer(tick(i));
    expect(s.ticks()).toEqual([]);
    expect(s.transport.stats()).toMatchObject({ visible: false, visibleSince: null, sent: 0, withheld: 5 });
  });

  it("resumes with one tick carrying the summed dt and folded beats", () => {
    const s = setup(false);
    s.transport.offer(tick(1, { nBeats: 1 }));
    s.transport.offer(tick(2, { nBeats: 2 }));
    s.state.visible = true;
    s.state.clock = 40;
    s.transport.offer(tick(3, { nBeats: 1, beatAt: 9 }));
    expect(s.ticks()).toHaveLength(1);
    const first = s.ticks()[0];
    expect(first.seq).toBe(3);
    expect(first.nBeats).toBe(4);
    expect(first.dt).toBeCloseTo(3 / 30);
    expect(first.beatAt).toBe(9);
    expect(s.transport.stats()).toMatchObject({ visible: true, visibleSince: 40, sent: 1 });
  });

  it("records acks and hands other frame messages on", () => {
    const received: string[] = [];
    const posted: HostMessage[] = [];
    const port: HostPort = { postMessage: (m) => posted.push(m), close: () => {}, onmessage: null };
    let clock = 5;
    const transport = createTransport({
      port,
      isVisible: () => true,
      now: () => clock,
      onFrameMessage: (m) => received.push(m.type),
    });
    transport.offer(tick(1));
    clock = 9;
    port.onmessage?.({ data: { type: "ack", seq: 1, ms: 3.5 } });
    port.onmessage?.({ data: { type: "ready", metered: false } });
    port.onmessage?.({ data: { nonsense: true } });
    expect(received).toEqual(["ready"]);
    expect(transport.stats()).toMatchObject({
      acked: 1,
      lastAckAt: 9,
      lastAckMs: 3.5,
      lastSentAt: 5,
      outstanding: 0,
    });
  });

  it("posts other messages, and sends dispose once", () => {
    const s = setup();
    s.transport.post({ type: "meter", on: true });
    s.transport.dispose();
    s.transport.dispose();
    s.transport.post({ type: "meter", on: false });
    s.transport.offer(tick(1));
    expect(s.posted.map((m) => m.type)).toEqual(["meter", "dispose"]);
    expect(s.port.onmessage).toBeNull();
  });

  it("reset forgets in-flight ticks and the held tick", () => {
    const s = setup();
    for (let i = 1; i <= 4; i++) s.transport.offer(tick(i));
    s.transport.reset();
    expect(s.transport.stats().outstanding).toBe(0);
    s.ack(2);
    expect(s.ticks()).toHaveLength(2);
  });
});
