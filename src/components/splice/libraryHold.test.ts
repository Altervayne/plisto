// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createLibraryHold } from "./libraryHold";

/** A player the test moves by hand. */
function player(start: { playing: boolean; trackId: number | null; positionSecs: number }) {
  const state = { ...start };
  const port = {
    read: () => ({ ...state }),
    pause: vi.fn(() => {
      state.playing = false;
    }),
    stop: vi.fn(() => {
      state.playing = false;
    }),
    restore: vi.fn(),
  };
  return { state, port };
}

/** A write the test settles by hand. */
function write() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const settle = async () => {
    resolve();
    await promise;
    await Promise.resolve();
  };
  return { promise, settle };
}

describe("createLibraryHold", () => {
  it("pauses on entry and restores at once when nothing is written", () => {
    const { port } = player({ playing: true, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    hold.enter();
    expect(port.pause).toHaveBeenCalledTimes(1);
    hold.leave();
    expect(port.restore).toHaveBeenCalledWith(30, true);
  });

  it("stops a sounding preview on leave", () => {
    const { state, port } = player({ playing: false, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    hold.enter();
    Object.assign(state, { playing: true, trackId: null });
    hold.leave();
    expect(port.stop).toHaveBeenCalledTimes(1);
  });

  it("holds the restore while a write is in flight, then runs it", async () => {
    const { port } = player({ playing: true, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    const work = write();
    hold.enter();
    hold.hold(work.promise);
    hold.leave();
    expect(hold.busy()).toBe(true);
    expect(port.restore).not.toHaveBeenCalled();
    await work.settle();
    expect(hold.busy()).toBe(false);
    expect(port.restore).toHaveBeenCalledWith(30, true);
  });

  it("takes a waiting restore back on re-entry and keeps the first capture", async () => {
    const { port } = player({ playing: true, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    const work = write();
    hold.enter();
    hold.hold(work.promise);
    hold.leave();
    hold.enter();
    await work.settle();
    expect(port.restore).not.toHaveBeenCalled();
    hold.leave();
    expect(port.restore).toHaveBeenCalledWith(30, true);
  });

  it("captures afresh on re-entry when the player moved while away", async () => {
    const { state, port } = player({ playing: true, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    const work = write();
    hold.enter();
    hold.hold(work.promise);
    hold.leave();
    Object.assign(state, { playing: true, trackId: 9, positionSecs: 2 });
    hold.enter();
    await work.settle();
    expect(port.restore).not.toHaveBeenCalled();
    hold.leave();
    expect(port.restore).toHaveBeenCalledWith(2, true);
  });

  it("drops the restore when the player moved since leaving", async () => {
    const { state, port } = player({ playing: false, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    const work = write();
    hold.enter();
    hold.hold(work.promise);
    hold.leave();
    Object.assign(state, { playing: true, trackId: 12 });
    await work.settle();
    expect(port.restore).not.toHaveBeenCalled();
  });

  it("drops the restore when the play head moved, and keeps it within the slack", async () => {
    for (const [moveTo, restored] of [
      [31, false],
      [30.4, true],
    ] as const) {
      const { state, port } = player({ playing: false, trackId: 5, positionSecs: 30 });
      const hold = createLibraryHold(port);
      const work = write();
      hold.enter();
      hold.hold(work.promise);
      hold.leave();
      state.positionSecs = moveTo;
      await work.settle();
      expect(port.restore.mock.calls.length, String(moveTo)).toBe(restored ? 1 : 0);
    }
  });

  it("restores after a stopped preview, whatever its play head read", async () => {
    const { state, port } = player({ playing: false, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    const work = write();
    hold.enter();
    Object.assign(state, { playing: true, trackId: null, positionSecs: 12 });
    hold.hold(work.promise);
    hold.leave();
    state.positionSecs = 0;
    await work.settle();
    expect(port.restore).toHaveBeenCalledWith(30, false);
  });

  it("seats a rewritten captured track from the start, and leaves another track's position", async () => {
    const { port } = player({ playing: true, trackId: 5, positionSecs: 30 });
    const hold = createLibraryHold(port);
    const work = write();
    hold.enter();
    hold.hold(work.promise);
    hold.fileRewritten(6);
    hold.leave();
    hold.enter();
    hold.fileRewritten(5);
    hold.leave();
    await work.settle();
    expect(port.restore).toHaveBeenCalledWith(0, true);
  });
});
