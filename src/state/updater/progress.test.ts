// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { EMPTY_TALLY, PROGRESS_INTERVAL_MS, createProgressFeed, tallyEvent, tallyFraction } from "./progress";

// -- Type Imports --
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

const started = (contentLength?: number): DownloadEvent => ({ event: "Started", data: { contentLength } });
const chunk = (chunkLength: number): DownloadEvent => ({ event: "Progress", data: { chunkLength } });
const finished: DownloadEvent = { event: "Finished" };

describe("tallyEvent", () => {
  it("sums chunk lengths over the announced size", () => {
    const tally = [started(1000), chunk(250), chunk(250)].reduce(tallyEvent, EMPTY_TALLY);
    expect(tally).toEqual({ received: 500, total: 1000 });
    expect(tallyFraction(tally)).toBe(0.5);
  });

  it("reads an unknown size as indeterminate", () => {
    const tally = [started(undefined), chunk(250)].reduce(tallyEvent, EMPTY_TALLY);
    expect(tallyFraction(tally)).toBeNull();
    expect(tallyFraction({ received: 0, total: 0 })).toBeNull();
  });

  it("caps at full and fills on finish", () => {
    expect(tallyFraction([started(100), chunk(150)].reduce(tallyEvent, EMPTY_TALLY))).toBe(1);
    expect(tallyFraction([started(100), chunk(10), finished].reduce(tallyEvent, EMPTY_TALLY))).toBe(1);
  });
});

describe("createProgressFeed", () => {
  it("coalesces a burst of chunks into one value per interval", () => {
    let now = 0;
    const seen: (number | null)[] = [];
    const feed = createProgressFeed((p) => seen.push(p), () => now);

    feed(started(1000));
    for (let i = 0; i < 50; i++) {
      now += 1;
      feed(chunk(10));
    }
    expect(seen).toEqual([0]);

    now += PROGRESS_INTERVAL_MS;
    feed(chunk(10));
    expect(seen).toEqual([0, 0.51]);
  });

  it("always reports the finish, however soon it lands", () => {
    let now = 0;
    const seen: (number | null)[] = [];
    const feed = createProgressFeed((p) => seen.push(p), () => now);
    feed(started(100));
    now += 1;
    feed(chunk(100));
    feed(finished);
    expect(seen).toEqual([0, 1]);
  });
});
