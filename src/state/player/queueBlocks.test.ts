// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { blockAt, moveInQueue, removeFromQueueView } from "./queueBlocks";

// -- Type Imports --
import type { QueueView } from "./queueBlocks";

// Ids 1 and 7 are loose; 2, 3, 4 are one block, 5 and 6 another.
const view = (): QueueView => ({ ids: [1, 2, 3, 4, 5, 6, 7], blocks: [[1, 3], [4, 2]] });

describe("moveInQueue", () => {
  it("keeps a member inside its block when it moves within the span", () => {
    const out = moveInQueue(view(), 1, 3);
    expect(out.ids).toEqual([1, 3, 4, 2, 5, 6, 7]);
    expect(out.blocks).toEqual([[1, 3], [4, 2]]);
  });

  it("keeps a member that drops at either end of its span", () => {
    expect(moveInQueue(view(), 2, 1).blocks).toEqual([[1, 3], [4, 2]]);
    expect(moveInQueue(view(), 2, 3).blocks).toEqual([[1, 3], [4, 2]]);
  });

  it("clears a member dragged out of its block and shrinks the block", () => {
    const out = moveInQueue(view(), 2, 6);
    expect(out.ids).toEqual([1, 2, 4, 5, 6, 7, 3]);
    expect(out.blocks).toEqual([[1, 2], [3, 2]]);
  });

  it("drops a block that falls to one row", () => {
    const out = moveInQueue(view(), 4, 0);
    expect(out.ids).toEqual([5, 1, 2, 3, 4, 6, 7]);
    expect(out.blocks).toEqual([[2, 3]]);
  });

  it("lands a foreign track dropped inside a block after the block", () => {
    const out = moveInQueue(view(), 0, 2);
    expect(out.ids).toEqual([2, 3, 4, 1, 5, 6, 7]);
    expect(out.blocks).toEqual([[0, 3], [4, 2]]);
  });

  it("lands a member of another block dropped inside a block after it, detached", () => {
    const out = moveInQueue(view(), 4, 2);
    expect(out.ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.blocks).toEqual([[1, 3]]);
  });

  it("moves a block's own track between blocks when it lands between them", () => {
    const out = moveInQueue(view(), 6, 4);
    expect(out.ids).toEqual([1, 2, 3, 4, 7, 5, 6]);
    expect(out.blocks).toEqual([[1, 3], [5, 2]]);
  });

  it("leaves the queue alone for an empty queue, a stale index or a same-slot move", () => {
    const start = view();
    expect(moveInQueue(start, 3, 3)).toBe(start);
    expect(moveInQueue(start, 9, 0)).toBe(start);
    const empty: QueueView = { ids: [], blocks: [] };
    expect(moveInQueue(empty, 0, 1)).toBe(empty);
  });

  it("clamps a destination past the end", () => {
    const out = moveInQueue(view(), 0, 99);
    expect(out.ids).toEqual([2, 3, 4, 5, 6, 7, 1]);
    expect(out.blocks).toEqual([[0, 3], [3, 2]]);
  });
});

describe("moveInQueue with a detached member", () => {
  const start = (): QueueView => ({ ids: [1, 11, 12, 13, 7], blocks: [[1, 3]] });

  it("re-attaches a member dragged out when it is dropped back inside its span", () => {
    const out = moveInQueue(start(), 2, 4);
    expect(out.ids).toEqual([1, 11, 13, 7, 12]);
    expect(out.blocks).toEqual([[1, 2]]);
    const back = moveInQueue(out, 4, 2);
    expect(back.ids).toEqual([1, 11, 12, 13, 7]);
    expect(back.blocks).toEqual([[1, 3]]);
  });

  it("re-attaches next to a lone attached member the wire does not show", () => {
    const out = moveInQueue({ ids: [1, 11, 12, 7], blocks: [[1, 2]] }, 1, 3);
    expect(out.ids).toEqual([1, 12, 7, 11]);
    expect(out.blocks).toEqual([]);
    expect(moveInQueue(out, 3, 1).blocks).toEqual([[1, 2]]);
    expect(moveInQueue(out, 3, 2).blocks).toEqual([[1, 2]]);
  });

  it("leaves a detached member out when it is dropped elsewhere", () => {
    const out = moveInQueue(start(), 2, 4);
    expect(moveInQueue(out, 4, 0).blocks).toEqual([[2, 2]]);
  });

  it("carries the hidden state through a remove", () => {
    const out = removeFromQueueView(moveInQueue(start(), 2, 4), 0);
    expect(moveInQueue(out, 3, 1).blocks).toEqual([[0, 3]]);
  });
});

describe("removeFromQueueView", () => {
  it("shrinks a block and shifts the ones after it", () => {
    const out = removeFromQueueView(view(), 2);
    expect(out.ids).toEqual([1, 2, 4, 5, 6, 7]);
    expect(out.blocks).toEqual([[1, 2], [3, 2]]);
  });

  it("leaves no block when one row remains", () => {
    const out = removeFromQueueView({ ids: [1, 2, 3], blocks: [[1, 2]] }, 1);
    expect(out.blocks).toEqual([]);
  });

  it("shifts spans after a removed loose row", () => {
    const out = removeFromQueueView(view(), 0);
    expect(out.blocks).toEqual([[0, 3], [3, 2]]);
  });

  it("leaves the queue alone for an out-of-range index", () => {
    const start = view();
    expect(removeFromQueueView(start, 9)).toBe(start);
  });
});

describe("blockAt", () => {
  it("finds the span holding a row, or -1", () => {
    expect(blockAt([[1, 3], [4, 2]], 0)).toBe(-1);
    expect(blockAt([[1, 3], [4, 2]], 3)).toBe(0);
    expect(blockAt([[1, 3], [4, 2]], 4)).toBe(1);
    expect(blockAt([[1, 3], [4, 2]], 6)).toBe(-1);
  });
});
