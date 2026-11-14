// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { startResumeWriter } from "./useResumeWriter";
import { usePlayerStore } from "./store";
import { streamStatusFixture } from "./streamFixtures";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({ setSetting: vi.fn(async () => {}) }));

const mocked = vi.mocked(ipc);
let stop: () => void;

/** The statuses the engine emits with a stream seated over a parked track. */
const withStream = (over: Parameters<typeof streamStatusFixture>[0], position = 0) => ({
  ...usePlayerStore.getState().status,
  track_id: -41,
  position_secs: position,
  stream: streamStatusFixture(over),
});

const written = (): Record<string, unknown>[] =>
  mocked.setSetting.mock.calls.map(([, json]) => JSON.parse(json as string));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  usePlayerStore.setState({
    status: { ...usePlayerStore.getState().status, track_id: null, playing: false, stream: null },
    queue: [3, 5, 8],
  });
  stop = startResumeWriter();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("resume writer with a stream seated", () => {
  it("writes at once when the stream takes the seat over a parked track", () => {
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 5, secs: 12 } }) });
    expect(written()).toEqual([
      expect.objectContaining({ ids: [3, 5, 8], current_id: 5, secs: 12 }),
    ]);
  });

  it("writes at once when the parked track changes", () => {
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 5, secs: 12 } }) });
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 8, secs: 0 } }) });
    expect(written().map((b) => b.current_id)).toEqual([5, 8]);
  });

  it("writes nothing new on a stream position tick, even after the timer", () => {
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 5, secs: 12 } }) });
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 5, secs: 12 } }, 30) });
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 5, secs: 12 } }, 31) });
    vi.advanceTimersByTime(5000);
    expect(mocked.setSetting).toHaveBeenCalledTimes(1);
  });

  it("writes the cleared blob at once on Clear queue", () => {
    usePlayerStore.setState({ status: withStream({ parked: { track_id: 5, secs: 12 } }) });
    usePlayerStore.setState({ status: withStream({ parked: null, parked_cleared: true }) });
    expect(written()[1]).toEqual(expect.objectContaining({ ids: [], current_id: 0 }));
  });

  it("writes nothing while nothing is parked and nothing is cleared", () => {
    usePlayerStore.setState({ status: withStream({ parked: null, parked_cleared: false }) });
    vi.advanceTimersByTime(5000);
    expect(mocked.setSetting).not.toHaveBeenCalled();
  });

  it("never writes the stream's ad-hoc id as the current track", () => {
    usePlayerStore.setState({ queue: [3, 5, 8, -41], status: withStream({ parked: { track_id: 5, secs: 1 } }) });
    vi.advanceTimersByTime(5000);
    for (const blob of written()) {
      expect(blob.current_id).toBe(5);
      expect(blob.ids).not.toContain(-41);
    }
  });
});
