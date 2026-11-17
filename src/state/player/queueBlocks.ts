/*
 * The optimistic side of the queue's blocks: a move or a remove applied to the ids and block spans the
 * store holds, ahead of the engine's echo. Pure, and it mirrors audio/queue.rs: a member dropped within
 * its block's span (ends included) is attached there, one dropped elsewhere is detached, a track that is
 * not a member lands after the block it is dropped into, and a run of one row is not a block on the wire.
 *
 * The wire carries spans only, so a detached member and a lone attached one are invisible in it. Rows
 * carries that hidden state (each row's block token and detached flag) through consecutive local edits so
 * a member dragged out can be dropped back in. A view without rows reads every spanned row as attached.
 */

// -- Type Imports --
import type { QueueBlock } from "../../types";

/** Per-row block state: the token of the block a row belongs to (-1 for none) and whether it is detached. */
export interface QueueRows {
  tokens: number[];
  detached: boolean[];
}

/** The queue ids in play order with the block spans over them, and the hidden row state when known. */
export interface QueueView {
  ids: number[];
  blocks: QueueBlock[];
  rows?: QueueRows;
}

/** The row state a bare span list implies: spanned rows attached to their span, all others free. */
function rowsOf(length: number, blocks: QueueBlock[]): QueueRows {
  const tokens = new Array<number>(length).fill(-1);
  blocks.forEach(([start, len], block) => {
    for (let i = start; i < start + len && i < length; i++) tokens[i] = block;
  });
  return { tokens, detached: new Array<boolean>(length).fill(false) };
}

/** The token a row plays in, or -1 when it has none or was dragged out of it. */
function memberOf(rows: QueueRows, i: number): number {
  return rows.detached[i] ? -1 : rows.tokens[i];
}

/** The spans of the runs of two or more attached rows sharing a token. */
export function spansOfRows(rows: QueueRows): QueueBlock[] {
  const spans: QueueBlock[] = [];
  let i = 0;
  while (i < rows.tokens.length) {
    const token = memberOf(rows, i);
    let end = i + 1;
    while (token >= 0 && end < rows.tokens.length && memberOf(rows, end) === token) end++;
    if (token >= 0 && end - i > 1) spans.push([i, end - i]);
    i = end;
  }
  return spans;
}

/** The end, exclusive, of the unit holding row `i`: its block's last attached member plus one. */
function unitEnd(rows: QueueRows, i: number): number {
  const token = memberOf(rows, i);
  let end = i + 1;
  while (token >= 0 && end < rows.tokens.length && memberOf(rows, end) === token) end++;
  return end;
}

/** Where a row dropped at slot `at` lands: after the block when `at` falls between two of its members. */
function outsideBlocks(rows: QueueRows, at: number): number {
  const before = at > 0 ? memberOf(rows, at - 1) : -1;
  const after = at < rows.tokens.length ? memberOf(rows, at) : -1;
  return before >= 0 && before === after ? unitEnd(rows, at) : at;
}

/** The index of the span holding row `index`, or -1 when it is in none. */
export function blockAt(blocks: QueueBlock[], index: number): number {
  return blocks.findIndex(([start, length]) => index >= start && index < start + length);
}

/** The queue after the row at `from` moved to `to`. Unchanged for an out-of-range or same-slot move. */
export function moveInQueue(view: QueueView, from: number, to: number): QueueView {
  const { ids, blocks } = view;
  if (from < 0 || from >= ids.length || from === to) return view;

  const state = view.rows ?? rowsOf(ids.length, blocks);
  const token = state.tokens[from];
  let detached = state.detached[from];
  const rest = ids.filter((_, i) => i !== from);
  const rows: QueueRows = {
    tokens: state.tokens.filter((_, i) => i !== from),
    detached: state.detached.filter((_, i) => i !== from),
  };
  let dest = Math.min(Math.max(to, 0), rest.length);

  // The block's attached members left behind; the row rejoins it when dropped on that span, ends included.
  const start = token >= 0 ? rows.tokens.findIndex((t, i) => t === token && !rows.detached[i]) : -1;
  if (start >= 0 && dest >= start && dest <= unitEnd(rows, start)) {
    detached = false;
  } else {
    if (start >= 0) detached = true;
    dest = outsideBlocks(rows, dest);
  }

  rest.splice(dest, 0, ids[from]);
  rows.tokens.splice(dest, 0, token);
  rows.detached.splice(dest, 0, detached);
  return { ids: rest, blocks: spansOfRows(rows), rows };
}

/** The queue after the row at `index` was removed. Unchanged for an out-of-range index. */
export function removeFromQueueView(view: QueueView, index: number): QueueView {
  const { ids, blocks } = view;
  if (index < 0 || index >= ids.length) return view;
  const state = view.rows ?? rowsOf(ids.length, blocks);
  const rows: QueueRows = {
    tokens: state.tokens.filter((_, i) => i !== index),
    detached: state.detached.filter((_, i) => i !== index),
  };
  return { ids: ids.filter((_, i) => i !== index), blocks: spansOfRows(rows), rows };
}
