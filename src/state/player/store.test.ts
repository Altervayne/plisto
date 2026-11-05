// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { usePlayerStore } from "./store";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  getPlayerQueue: vi.fn(async () => []),
  getPlayerStatus: vi.fn(),
  getTrackDisplay: vi.fn(),
  playerEnqueue: vi.fn(async () => {}),
  playerJump: vi.fn(),
  playerMoveQueueItem: vi.fn(),
  playerNext: vi.fn(),
  playerPause: vi.fn(),
  playerPlayNext: vi.fn(async () => {}),
  playerPlayTracks: vi.fn(async () => {}),
  playerPrev: vi.fn(),
  playerRemoveQueueItem: vi.fn(),
  playerResume: vi.fn(),
  playerSeek: vi.fn(),
  playerSetRepeat: vi.fn(),
  playerSetShuffle: vi.fn(),
  playerSetVolume: vi.fn(),
  playerStop: vi.fn(),
  playerToggle: vi.fn(),
}));

vi.mock("./queueToast", () => ({ added: vi.fn() }));

const mocked = vi.mocked(ipc);
const source = { kind: "files" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState({ status: { ...usePlayerStore.getState().status, track_id: null } });
});

describe("playNext", () => {
  it("inserts through the engine command when a track is loaded", () => {
    usePlayerStore.setState({ status: { ...usePlayerStore.getState().status, track_id: 7 } });
    usePlayerStore.getState().actions.playNext([1, 2], source);
    expect(mocked.playerPlayNext).toHaveBeenCalledWith([1, 2]);
    expect(mocked.playerPlayTracks).not.toHaveBeenCalled();
  });

  it("starts a fresh play when nothing is loaded", () => {
    usePlayerStore.getState().actions.playNext([1, 2], source);
    expect(mocked.playerPlayNext).not.toHaveBeenCalled();
    expect(mocked.playerPlayTracks).toHaveBeenCalled();
  });
});
