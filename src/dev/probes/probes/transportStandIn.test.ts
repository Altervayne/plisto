// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { observeClockStep, timeBatches, TransportSender } from "./transportStandIn";
import type { Tick, TickSample } from "./transportStandIn";

function sample(over: Partial<TickSample> = {}): TickSample {
  return { dt: 0.01, beat: 0, flux: 0, kick: 0, level: 0.5, bands: new Float32Array(4), raw: new Float32Array(4), ...over };
}

function make(credits?: number): { sender: TransportSender; sent: Tick[] } {
  const sent: Tick[] = [];
  return { sender: new TransportSender((t) => sent.push(t), credits), sent };
}

describe("TransportSender", () => {
  it("numbers ticks from 1 and stops at two unacknowledged", () => {
    const { sender, sent } = make();
    for (let i = 0; i < 5; i++) sender.push(sample());
    expect(sent.map((t) => t.seq)).toEqual([1, 2]);
    expect(sender.outstanding).toBe(2);
  });

  it("sends again once an ack frees a credit, carrying what was folded meanwhile", () => {
    const { sender, sent } = make();
    sender.push(sample());
    sender.push(sample());
    sender.push(sample({ dt: 0.02, level: 0.7 }));
    sender.push(sample({ dt: 0.03, level: 0.9 }));
    sender.ack(1);
    const tick = sender.push(sample({ dt: 0.04, level: 0.2 }));
    expect(tick?.seq).toBe(3);
    expect(sent).toHaveLength(3);
    expect(tick?.dt).toBeCloseTo(0.09, 9);
    expect(tick?.level).toBe(0.2);
  });

  it("keeps the max of beat, flux and kick and the latest of the rest", () => {
    const { sender, sent } = make(1);
    sender.push(sample({ beat: 1, flux: 0.2, kick: 0.9 }));
    sender.push(sample({ beat: 0, flux: 0.8, kick: 0.3, level: 0.4 }));
    sender.push(sample({ beat: 0.5, flux: 0.1, kick: 0, level: 0.6 }));
    sender.ack(1);
    const merged = sender.push(sample({ beat: 0, flux: 0, kick: 0, level: 0.65 }));
    expect(sent[0].beat).toBe(1);
    expect(merged).toMatchObject({ seq: 2, beat: 0.5, flux: 0.8, kick: 0.3, level: 0.65, nBeats: 1 });
    expect(sender.stats().beatsIn).toBe(2);
  });

  it("loses no dt and no beat across a long run with a slow consumer", () => {
    const { sender, sent } = make();
    let beats = 0;
    let dt = 0;
    for (let i = 0; i < 600; i++) {
      const beat = i % 30 === 0 ? 1 : 0;
      beats += beat;
      dt += 0.007;
      sender.push(sample({ dt: 0.007, beat }));
      if (i % 5 === 4 && sent.length) sender.ack(sent[sent.length - 1].seq);
    }
    const s = sender.stats();
    expect(s.beatsSent + s.beatsPending).toBe(beats);
    expect(s.dtSent + s.dtPending).toBeCloseTo(dt, 9);
    expect(s.maxOutstanding).toBeLessThanOrEqual(2);
  });

  it("does not grow under a consumer that never acks", () => {
    const { sender, sent } = make();
    for (let i = 0; i < 2000; i++) sender.push(sample({ beat: i % 7 === 0 ? 1 : 0 }));
    expect(sent).toHaveLength(2);
    expect(sender.stats().samples).toBe(2000);
    expect(sender.outstanding).toBe(2);
  });

  it("ignores a stale or future ack", () => {
    const { sender } = make();
    sender.push(sample());
    sender.ack(0);
    expect(sender.outstanding).toBe(1);
    sender.ack(99);
    expect(sender.outstanding).toBe(0);
  });
});

describe("timeBatches", () => {
  it("divides each batch by its size", () => {
    let t = 0;
    const timing = timeBatches(3, 10, () => (t += 0.25), () => t);
    expect(timing.batchMs).toEqual([2.5, 2.5, 2.5]);
    expect(timing.perItem).toEqual([0.25, 0.25, 0.25]);
  });

  it("runs every step once, numbered across batches", () => {
    const seen: number[] = [];
    timeBatches(2, 3, (i) => seen.push(i), () => 0);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("recovers a cost below a coarse clock step from the batch", () => {
    let t = 0;
    const coarse = () => Math.floor(t / 0.1) * 0.1;
    const timing = timeBatches(50, 100, () => (t += 0.02), coarse);
    const mean = timing.perItem.reduce((a, b) => a + b, 0) / timing.perItem.length;
    expect(mean).toBeCloseTo(0.02, 3);
  });
});

describe("observeClockStep", () => {
  it("reports the smallest step the clock was seen to take", () => {
    let t = 0;
    let calls = 0;
    const clock = () => {
      calls++;
      if (calls % 3 === 0) t += 0.1;
      return Math.round(t * 1000) / 1000;
    };
    expect(observeClockStep(clock, 10)).toBeCloseTo(0.1, 6);
  });

  it("reports 0 for a clock that never moves", () => {
    expect(observeClockStep(() => 5, 3, 50)).toBe(0);
  });
});
