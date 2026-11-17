// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Type Imports --
import type { PlayerStatus } from "../../types";

vi.mock("../../lib/ipc", () => ({
  getPlayerStatus: vi.fn(),
  getSetting: vi.fn(),
  getTrackDisplay: vi.fn(async () => ({ title: "t", artist: null })),
  playerLoad: vi.fn(async () => true),
  playerSetRepeat: vi.fn(async () => {}),
  playerSetVolume: vi.fn(async () => {}),
}));
vi.mock("../store", () => ({ useAppStore: { getState: () => ({ tracks: [] }) } }));

const savedBlob = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, ids: [3, 5, 8], current_id: 5, secs: 12, volume: 0.5, repeat: "off", ...over });

/**
 * Runs the restore against an engine reporting `status`, on a fresh module graph: the restore runs once
 * per session behind a module flag. `blob` adds fields to the saved blob. Resolves the ipc mocks the run used.
 */
async function restore(status: Partial<PlayerStatus>, blob: Record<string, unknown> = {}) {
  vi.resetModules();
  const ipc = vi.mocked(await import("../../lib/ipc"));
  vi.clearAllMocks();
  ipc.getSetting.mockResolvedValue(savedBlob(blob));
  ipc.getPlayerStatus.mockResolvedValue({
    playing: false,
    track_id: null,
    position_secs: 0,
    duration_secs: 0,
    volume: 1,
    repeat: "off",
    queue_index: 0,
    queue_len: 0,
    shuffle: false,
    output_device: null,
    output_taken_over: false,
    stream: null,
    start_seq: 0,
    seek_seq: 0,
    ...status,
  });
  const { restoreResume } = await import("./restoreResume");
  await restoreResume();
  return ipc;
}

const seated = (parked: { track_id: number; secs: number } | null, parked_cleared: boolean) => ({
  track_id: -41,
  stream: { live: true, seekable: false, phase: "playing" as const, parked, parked_cleared },
});

describe("boot restore", () => {
  it("loads the saved queue when nothing plays", async () => {
    const ipc = await restore({});
    expect(ipc.playerLoad).toHaveBeenCalledWith([3, 5, 8], 5, 12, undefined, undefined);
  });

  it("hands the saved blocks and current row to the load", async () => {
    const ipc = await restore({}, { blocks: [[1, 2]], index: 1 });
    expect(ipc.playerLoad).toHaveBeenCalledWith([3, 5, 8], 5, 12, 1, [[1, 2]]);
  });

  it("sends a blob without blocks or a row as an older build wrote it", async () => {
    const ipc = await restore({}, { blocks: undefined, index: undefined });
    expect(ipc.playerLoad).toHaveBeenCalledWith([3, 5, 8], 5, 12, undefined, undefined);
  });

  it("leaves a playing library track alone", async () => {
    const ipc = await restore({ track_id: 9 });
    expect(ipc.playerLoad).not.toHaveBeenCalled();
  });

  it("loads into the parked slot when a stream is seated with nothing parked and nothing cleared", async () => {
    const ipc = await restore(seated(null, false));
    expect(ipc.playerLoad).toHaveBeenCalledWith([3, 5, 8], 5, 12, undefined, undefined);
  });

  it("skips when a stream is seated and a track is already parked", async () => {
    const ipc = await restore(seated({ track_id: 7, secs: 0 }, false));
    expect(ipc.playerLoad).not.toHaveBeenCalled();
  });

  it("skips when a stream is seated and the user cleared the queue", async () => {
    const ipc = await restore(seated(null, true));
    expect(ipc.playerLoad).not.toHaveBeenCalled();
  });
});
