// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { judgeRun, judgeTransport } from "./p06Transport";
import type { FrameTotals, RunResult } from "./p06Transport";

function totals(over: Partial<FrameTotals> = {}): FrameTotals {
  return { received: 600, beatsSeen: 40, dtSum: 20, consumed: 580, beatFrames: 40, consumedDt: 20, maxBehind: 2, ...over };
}

function run(over: Partial<RunResult> = {}, frame: Partial<FrameTotals> | null = {}): RunResult {
  return {
    label: "run",
    frames: 2900,
    seconds: 20,
    sender: {
      samples: 2900,
      ticks: 600,
      maxOutstanding: 2,
      outstanding: 0,
      beatsIn: 40,
      beatsSent: 40,
      beatsPending: 0,
      dtIn: 20,
      dtSent: 20,
      dtPending: 0,
    },
    totals: frame === null ? null : totals(frame),
    roundTrip: new Array(580).fill(8),
    oneWay: [],
    unusable: null,
    ...over,
  };
}

describe("judgeRun", () => {
  it("accepts a run whose frame counted every beat", () => {
    expect(judgeRun(run())).toEqual([]);
  });

  it("fails when the frame consumed fewer beats than were sent, however the sender counted", () => {
    const problems = judgeRun(run({}, { beatFrames: 31, beatsSeen: 40 }));
    expect(problems.join(" ")).toContain("fewer than the 40 beats sent");
  });

  it("fails a consumer that stalled after a few acks", () => {
    const stalled = run(
      {
        sender: { ...run().sender, ticks: 2, beatsSent: 1, beatsPending: 39, dtSent: 0.02, dtPending: 19.98 },
        roundTrip: [8, 8],
      },
      { received: 2, beatsSeen: 1, beatFrames: 1, dtSum: 0.02, consumed: 2 },
    );
    const text = judgeRun(stalled).join(" ");
    expect(text).toContain("starved");
    expect(text).toContain("under the floor of 160");
  });

  it("fails ticks lost in delivery", () => {
    const text = judgeRun(run({}, { received: 590 })).join(" ");
    expect(text).toContain("received 590 of 600");
  });

  it("fails a consumer that stopped in the last half second with no beat in the gap", () => {
    const text = judgeRun(run({}, { consumedDt: 19.5, consumed: 570 })).join(" ");
    expect(text).toContain("consumed 19.5000 s of dt of 20.0000 s sent");
    expect(text).toContain("570 ticks but 580 acks");
  });

  it("fails ticks still unacknowledged after the drain", () => {
    const r = run();
    r.sender = { ...r.sender, outstanding: 1 };
    expect(judgeRun(r).join(" ")).toContain("1 ticks still unacknowledged");
  });

  it("does not judge the sender's own bookkeeping", () => {
    const r = run();
    r.sender = { ...r.sender, beatsIn: 99, dtIn: 99 };
    expect(judgeRun(r)).toEqual([]);
  });
});

describe("judgeTransport", () => {
  it("passes good runs and a post cost under 0.1 ms", () => {
    expect(judgeTransport([run(), run()], 0.0999).state).toBe("pass");
  });

  it("fails a post cost of 0.1 ms or more", () => {
    const v = judgeTransport([run(), run()], 0.1);
    expect(v.state).toBe("fail");
    expect(v.problems.join(" ")).toContain("post cost");
  });

  it("is invalid, not a pass or a fail, when a frame gave no report", () => {
    const v = judgeTransport([run(), run({}, null)], 0.01);
    expect(v.state).toBe("invalid");
  });

  it("is invalid, not a failure, when the page was hidden or a run ended short", () => {
    const hidden = run({ unusable: "the page was hidden during the run" }, { received: 3 });
    const v = judgeTransport([run(), hidden], 0.01);
    expect(v.state).toBe("invalid");
    expect(v.problems.join(" ")).toContain("hidden");
    expect(judgeTransport([run({ unusable: "the run ended after 3.0 s of 20 s" })], 0.01).state).toBe("invalid");
  });

  it("fails when any run has a problem", () => {
    expect(judgeTransport([run(), run({}, { beatFrames: 0 })], 0.01).state).toBe("fail");
  });
});
