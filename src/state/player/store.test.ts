// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { streamSelectors, usePlayerStore } from "./store";
import { streamNowFixture, streamStatusFixture } from "./streamFixtures";

import { added, playsAfter } from "./queueToast";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  getPlayerQueueState: vi.fn(async () => ({ ids: [], blocks: [] })),
  getPlayerStatus: vi.fn(),
  getTrackDisplay: vi.fn(),
  getStreamNow: vi.fn(async () => null),
  playerClearParked: vi.fn(async () => {}),
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

vi.mock("./queueToast", () => ({ added: vi.fn(), playsAfter: vi.fn() }));

const mocked = vi.mocked(ipc);
const source = { kind: "files" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState({
    status: { ...usePlayerStore.getState().status, track_id: null, stream: null },
    streamNow: null,
  });
});

describe("playNext", () => {
  it("inserts through the engine command when a track is loaded", () => {
    usePlayerStore.setState({ status: { ...usePlayerStore.getState().status, track_id: 7 } });
    usePlayerStore.getState().actions.playNext([1, 2], source);
    expect(mocked.playerPlayNext).toHaveBeenCalledWith([1, 2], undefined);
    expect(mocked.playerPlayTracks).not.toHaveBeenCalled();
  });

  it("starts a fresh play when nothing is loaded", () => {
    usePlayerStore.getState().actions.playNext([1, 2], source);
    expect(mocked.playerPlayNext).not.toHaveBeenCalled();
    expect(mocked.playerPlayTracks).toHaveBeenCalled();
  });

  describe("with a stream seated", () => {
    const seat = (parked: { track_id: number; secs: number } | null) =>
      usePlayerStore.setState({
        status: {
          ...usePlayerStore.getState().status,
          track_id: -41,
          stream: streamStatusFixture({ parked }),
        },
        queueMeta: { 7: { title: "Harbor Lights", artist: null, durationSecs: null } },
      });

    it("inserts without starting anything and says where the tracks sit", () => {
      seat({ track_id: 7, secs: 3 });
      usePlayerStore.getState().actions.playNext([1], source);
      expect(mocked.playerPlayNext).toHaveBeenCalledWith([1], undefined);
      expect(mocked.playerPlayTracks).not.toHaveBeenCalled();
      expect(playsAfter).toHaveBeenCalledWith("Harbor Lights");
      expect(added).not.toHaveBeenCalled();
    });

    it("falls back to the count line when no track is parked", () => {
      seat(null);
      usePlayerStore.getState().actions.playNext([1, 2], source);
      expect(playsAfter).not.toHaveBeenCalled();
      expect(added).toHaveBeenCalledWith(2);
    });
  });
});

describe("blocks", () => {
  const loaded = (queue_index: number) =>
    usePlayerStore.setState({
      status: { ...usePlayerStore.getState().status, track_id: 7, queue_index },
      queue: [1, 2, 3, 4, 5],
      queueBlocks: [[1, 3]],
    });

  it("hands the spans to a play and an append", () => {
    loaded(0);
    usePlayerStore.getState().actions.play([1, 2, 3], 0, source, [[0, 2]]);
    expect(mocked.playerPlayTracks).toHaveBeenCalledWith([1, 2, 3], 0, [[0, 2]]);
    usePlayerStore.getState().actions.addToQueue([8, 9], source, [[0, 2]]);
    expect(mocked.playerEnqueue).toHaveBeenCalledWith([8, 9], [[0, 2]]);
  });

  it("reports a play next from inside a block as placed after it", () => {
    loaded(2);
    const outcome = usePlayerStore.getState().actions.playNext([9], source, [[0, 1]]);
    expect(outcome).toEqual({ afterBlock: true });
    expect(mocked.playerPlayNext).toHaveBeenCalledWith([9], [[0, 1]]);
  });

  it("reports a play next from outside a block, or a cold start, as not after one", () => {
    loaded(0);
    expect(usePlayerStore.getState().actions.playNext([9], source)).toEqual({ afterBlock: false });
    usePlayerStore.setState({ status: { ...usePlayerStore.getState().status, track_id: null } });
    expect(usePlayerStore.getState().actions.playNext([9], source)).toEqual({ afterBlock: false });
  });

  it("keeps the spans when the engine echoes a queue state", () => {
    usePlayerStore.getState().setQueue([4, 5, 6], [[0, 2]]);
    expect(usePlayerStore.getState().queueBlocks).toEqual([[0, 2]]);
    usePlayerStore.getState().setQueue([4]);
    expect(usePlayerStore.getState().queueBlocks).toEqual([]);
  });

  it("re-attaches a dragged-out member after the engine echoes the first move", () => {
    mocked.playerMoveQueueItem.mockResolvedValue(undefined);
    usePlayerStore.setState({ queue: [1, 11, 12, 13, 7], queueBlocks: [[1, 3]], queueRows: null });
    const { actions, setQueue } = usePlayerStore.getState();
    actions.reorderQueue(2, 4);
    setQueue([1, 11, 13, 7, 12], [[1, 2]]);
    actions.reorderQueue(4, 2);
    expect(usePlayerStore.getState().queue).toEqual([1, 11, 12, 13, 7]);
    expect(usePlayerStore.getState().queueBlocks).toEqual([[1, 3]]);
  });

  it("drops the hidden row state when the echo disagrees with it", () => {
    mocked.playerMoveQueueItem.mockResolvedValue(undefined);
    usePlayerStore.setState({ queue: [1, 11, 12, 13, 7], queueBlocks: [[1, 3]], queueRows: null });
    usePlayerStore.getState().actions.reorderQueue(2, 4);
    usePlayerStore.getState().setQueue([9, 8], []);
    expect(usePlayerStore.getState().queueRows).toBeNull();
  });

  it("moves and removes through the block rules ahead of the echo", () => {
    loaded(0);
    mocked.playerMoveQueueItem.mockResolvedValue(undefined);
    mocked.playerRemoveQueueItem.mockResolvedValue(undefined);
    usePlayerStore.getState().actions.reorderQueue(0, 2);
    // A loose track dropped inside the block lands after it.
    expect(usePlayerStore.getState().queue).toEqual([2, 3, 4, 1, 5]);
    expect(usePlayerStore.getState().queueBlocks).toEqual([[0, 3]]);
    expect(mocked.playerMoveQueueItem).toHaveBeenCalledWith(0, 2);
    usePlayerStore.getState().actions.removeFromQueue(0);
    expect(usePlayerStore.getState().queue).toEqual([3, 4, 1, 5]);
    expect(usePlayerStore.getState().queueBlocks).toEqual([[0, 2]]);
    usePlayerStore.getState().actions.removeFromQueue(0);
    expect(usePlayerStore.getState().queueBlocks).toEqual([]);
  });
});

describe("setQueue", () => {
  const album = { kind: "album", id: 3, label: "My Summer Romance" } as const;

  beforeEach(() => {
    mocked.getTrackDisplay.mockResolvedValue({ title: "Loose", artist: null });
    usePlayerStore.setState({ playingFrom: album, queue: [1, 2], queueMeta: {} });
  });

  it("drops the source when opened files replace the queue", () => {
    usePlayerStore.getState().setQueue([-4]);
    expect(usePlayerStore.getState().playingFrom).toBeNull();
  });

  it("keeps the source when opened files join a library queue", () => {
    usePlayerStore.getState().setQueue([1, 2, -4]);
    expect(usePlayerStore.getState().playingFrom).toEqual(album);
  });

  it("keeps the source for a library queue and for an emptied one", () => {
    usePlayerStore.getState().setQueue([2, 1]);
    expect(usePlayerStore.getState().playingFrom).toEqual(album);
    usePlayerStore.getState().setQueue([]);
    expect(usePlayerStore.getState().playingFrom).toEqual(album);
  });
});

describe("stream selectors", () => {
  const seat = () =>
    usePlayerStore.setState({
      status: { ...usePlayerStore.getState().status, track_id: -41, stream: streamStatusFixture() },
      streamNow: streamNowFixture({ art_rev: 2 }),
    });

  it("return primitives or the hub's own object, so a position tick changes none of them", () => {
    seat();
    const before = usePlayerStore.getState();
    usePlayerStore.setState({ status: { ...before.status, position_secs: before.status.position_secs + 1 } });
    const after = usePlayerStore.getState();
    expect(after.status).not.toBe(before.status);
    for (const select of Object.values(streamSelectors)) {
      expect(Object.is(select(after), select(before))).toBe(true);
    }
  });

  it("change when a stream is seated, rev'd or cleared", () => {
    const idle = usePlayerStore.getState();
    seat();
    const seated = usePlayerStore.getState();
    expect(streamSelectors.isStream(idle)).toBe(false);
    expect(streamSelectors.isStream(seated)).toBe(true);
    expect(streamSelectors.artRev(seated)).toBe(2);
    expect(streamSelectors.artRev(idle)).toBe(0);
    usePlayerStore.getState().setStreamNow(streamNowFixture({ art_rev: 3 }));
    expect(streamSelectors.artRev(usePlayerStore.getState())).toBe(3);
  });

  it("read the art revision as zero once the engine holds no stream", () => {
    usePlayerStore.setState({
      status: { ...usePlayerStore.getState().status, stream: null },
      streamNow: streamNowFixture({ art_rev: 4 }),
    });
    expect(streamSelectors.artRev(usePlayerStore.getState())).toBe(0);
  });
});

describe("clearParked", () => {
  it("asks the engine to empty the parked queue and never stops the stream", () => {
    usePlayerStore.getState().actions.clearParked();
    expect(mocked.playerClearParked).toHaveBeenCalledTimes(1);
    expect(mocked.playerStop).not.toHaveBeenCalled();
  });
});

describe("stream end", () => {
  const notice = { plugin_id: "night-radio", plugin_name: "Night Radio", reason: "network", detail: "closed" } as const;

  it("keeps a showing toast when a silent end arrives for another plugin", () => {
    usePlayerStore.getState().setStreamEnd(notice);
    usePlayerStore.getState().setStreamEnd({ ...notice, plugin_id: "other", reason: "replaced", detail: null });
    expect(usePlayerStore.getState().streamEnd).toEqual(notice);
    usePlayerStore.getState().setStreamEnd(null);
  });

  it("lets a silent end replace the toast of the same plugin, or fill an empty slot", () => {
    usePlayerStore.getState().setStreamEnd(notice);
    const silent = { ...notice, reason: "user", detail: null } as const;
    usePlayerStore.getState().setStreamEnd(silent);
    expect(usePlayerStore.getState().streamEnd).toEqual(silent);
    usePlayerStore.getState().setStreamEnd(null);
    usePlayerStore.getState().setStreamEnd(silent);
    expect(usePlayerStore.getState().streamEnd).toEqual(silent);
    usePlayerStore.getState().setStreamEnd(null);
  });

  it("holds the notice for the toast until it is cleared", () => {
    usePlayerStore.getState().setStreamEnd(notice);
    expect(usePlayerStore.getState().streamEnd).toEqual(notice);
    usePlayerStore.getState().setStreamEnd(null);
    expect(usePlayerStore.getState().streamEnd).toBeNull();
  });

  it("clears the hub state on a null event without touching the notice", () => {
    usePlayerStore.getState().setStreamNow(streamNowFixture());
    usePlayerStore.getState().setStreamEnd(notice);
    usePlayerStore.getState().setStreamNow(null);
    expect(usePlayerStore.getState().streamNow).toBeNull();
    expect(usePlayerStore.getState().streamEnd).toEqual(notice);
  });
});
