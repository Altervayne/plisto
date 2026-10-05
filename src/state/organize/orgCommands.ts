/*
 * The organize command engine: a pure, framework-free inverse-command stack over the album/membership
 * projection. Every undoable edit is a Command that captures its target, its next value, and enough of
 * the previous state to build a clean inverse. applyCommand is the pure reducer, invertCommand builds the
 * exact reverse, and commandToIpc is the write sink an undo reuses. The membership moves carry the full
 * before/after rows so a single inverse restores a moved track exactly - a move renumbers the album, so
 * the prior row must travel with the command, not be recomputed.
 */

// -- IPC Imports --
import {
  addTracksToAlbum,
  mergeDuplicates,
  reapplyAlbumsFromTags,
  removeTracksFromAlbum,
  revertAlbumsFromTags,
  setAlbumFields as ipcSetAlbumFields,
  setAlbumLayout as ipcSetAlbumLayout,
  setMemberPlacement,
  setTrackOverrides as ipcSetTrackOverrides,
  undoMergeDuplicates,
} from "../../lib/ipc";

// -- Type Imports --
import type {
  AlbumFields,
  AlbumRow,
  AlbumTrackRow,
  MergeReceipt,
  TagAlbumReceipt,
  TrackOverride,
  TrackPlacement,
} from "../../types";

/** The projection the reducer transforms: albums with their counts, and every membership row. */
export type OrgState = { albums: AlbumRow[]; membership: AlbumTrackRow[] };

/** A track's membership at rest: its full row when in an album, or just its id when loose. */
export type Placement =
  | { assigned: false; trackId: number }
  | { assigned: true; row: AlbumTrackRow };

/** Replaces an album's four editable fields; `prev` restores them. */
export interface SetAlbumFields {
  kind: "setAlbumFields";
  albumId: number;
  next: AlbumFields;
  prev: AlbumFields;
}

/** Replaces one membership row's overrides and numbering; `prev` restores them. */
export interface SetTrackOverrides {
  kind: "setTrackOverrides";
  albumId: number;
  trackId: number;
  next: TrackOverride;
  prev: TrackOverride;
}

/**
 * Rewrites an album's whole disc layout: each member's disc and per-disc position together. `next`
 * and `prev` each carry a placement per member, so the inverse restores the exact prior grouping and
 * numbering. A within-disc reorder or a disc reassignment both route through one layout.
 */
export interface SetAlbumLayout {
  kind: "setAlbumLayout";
  albumId: number;
  next: TrackPlacement[];
  prev: TrackPlacement[];
}

/**
 * Moves tracks into `albumId`. `before`/`after` hold each affected track's full placement on either
 * side, so the inverse (an unassign carrying the swapped sides) restores prior album, numbering and
 * overrides exactly. Assign and unassign are one reversible transition under two names.
 */
export interface AssignTracks {
  kind: "assign";
  albumId: number;
  trackIds: number[];
  before: Placement[];
  after: Placement[];
}

/** Removes tracks from `albumId` back to loose. The swapped-sides inverse re-adds their exact rows. */
export interface UnassignTracks {
  kind: "unassign";
  albumId: number;
  trackIds: number[];
  before: Placement[];
  after: Placement[];
}

/**
 * An albums-from-tags batch, already written when it lands on the stack. `applied` says which side the
 * library sits on: undo reverts the receipt, redo reapplies it under the same album ids. The projection
 * is not patched locally - the store reloads from the backend after each replay.
 */
export interface TagBatch {
  kind: "tagBatch";
  receipt: TagAlbumReceipt;
  applied: boolean;
}

/**
 * A possible-duplicates merge into a keeper, already written when it lands on the stack. Undo replays
 * the receipt back; redo runs the merge again over the same ids, which yields a fresh receipt. Like the
 * tag batch, the store reloads from the backend after each replay.
 */
export interface DuplicateMerge {
  kind: "duplicateMerge";
  keeperId: number;
  discardIds: number[];
  receipt: MergeReceipt;
  applied: boolean;
}

/**
 * The undoable edits: five in-place edits plus the albums-from-tags batch and the duplicate merge.
 * Create, delete and cover-set are structural, not on this stack.
 */
export type Command =
  | SetAlbumFields
  | SetTrackOverrides
  | SetAlbumLayout
  | AssignTracks
  | UnassignTracks
  | TagBatch
  | DuplicateMerge;

/** Applies a Command to the projection, returning the next one. Pure: no clock, no IO, no mutation. */
export function applyCommand(state: OrgState, cmd: Command): OrgState {
  switch (cmd.kind) {
    case "setAlbumFields":
      return {
        albums: state.albums.map((a) =>
          a.id === cmd.albumId
            ? {
                ...a,
                title: cmd.next.title,
                album_artist: cmd.next.album_artist,
                year: cmd.next.year,
                genre: cmd.next.genre,
              }
            : a,
        ),
        membership: state.membership,
      };

    case "setTrackOverrides":
      return {
        albums: state.albums,
        membership: state.membership.map((r) =>
          r.album_id === cmd.albumId && r.track_id === cmd.trackId
            ? {
                ...r,
                title_override: cmd.next.title_override,
                artist_override: cmd.next.artist_override,
                track_no: cmd.next.track_no,
                disc_no: cmd.next.disc_no,
              }
            : r,
        ),
      };

    case "setAlbumLayout": {
      const byId = new Map(cmd.next.map((p) => [p.track_id, p]));
      const membership = state.membership.map((r) => {
        const p = r.album_id === cmd.albumId ? byId.get(r.track_id) : undefined;
        return p ? { ...r, disc_no: p.disc_no, track_no: p.track_no } : r;
      });
      return { albums: state.albums, membership: sortMembership(membership) };
    }

    case "assign":
    case "unassign":
      return applyTransition(state, cmd.after);

    case "tagBatch":
    case "duplicateMerge":
      return state;
  }
}

/** Builds the exact inverse Command. invertCommand(invertCommand(c)) round-trips to `c`. */
export function invertCommand(cmd: Command): Command {
  switch (cmd.kind) {
    case "setAlbumFields":
      return { kind: "setAlbumFields", albumId: cmd.albumId, next: cmd.prev, prev: cmd.next };

    case "setTrackOverrides":
      return {
        kind: "setTrackOverrides",
        albumId: cmd.albumId,
        trackId: cmd.trackId,
        next: cmd.prev,
        prev: cmd.next,
      };

    case "setAlbumLayout":
      return { kind: "setAlbumLayout", albumId: cmd.albumId, next: cmd.prev, prev: cmd.next };

    case "assign":
      return {
        kind: "unassign",
        albumId: cmd.albumId,
        trackIds: cmd.trackIds,
        before: cmd.after,
        after: cmd.before,
      };

    case "unassign":
      return {
        kind: "assign",
        albumId: cmd.albumId,
        trackIds: cmd.trackIds,
        before: cmd.after,
        after: cmd.before,
      };

    case "tagBatch":
    case "duplicateMerge":
      return { ...cmd, applied: !cmd.applied };
  }
}

/** Writes a Command (a forward commit or an inverse) to the backend, reaching its `after` state. */
export async function commandToIpc(cmd: Command): Promise<void> {
  switch (cmd.kind) {
    case "setAlbumFields":
      await ipcSetAlbumFields(cmd.albumId, cmd.next);
      return;

    case "setTrackOverrides":
      await ipcSetTrackOverrides(cmd.albumId, cmd.trackId, cmd.next);
      return;

    case "setAlbumLayout":
      await ipcSetAlbumLayout(cmd.albumId, cmd.next);
      return;

    case "assign":
    case "unassign":
      await transitionToIpc(cmd.before, cmd.after);
      return;

    case "tagBatch":
      await (cmd.applied ? reapplyAlbumsFromTags(cmd.receipt) : revertAlbumsFromTags(cmd.receipt));
      return;

    case "duplicateMerge":
      await replayDuplicateMerge(cmd);
      return;
  }
}

/**
 * Writes one side of a duplicate merge and returns the entry as it now stands: undoing replays the
 * receipt, merging again swaps in the receipt that run produced.
 */
export async function replayDuplicateMerge(cmd: DuplicateMerge): Promise<DuplicateMerge> {
  if (!cmd.applied) {
    await undoMergeDuplicates(cmd.receipt);
    return cmd;
  }
  return { ...cmd, receipt: await mergeDuplicates(cmd.keeperId, cmd.discardIds) };
}

// ---- Membership transition ----

/** Sets every affected track to its `after` placement, dropping prior rows and recomputing counts. */
function applyTransition(state: OrgState, after: Placement[]): OrgState {
  const affected = new Set(after.map(placementTrackId));
  const kept = state.membership.filter((r) => !affected.has(r.track_id));
  const added = after.filter((p): p is Extract<Placement, { assigned: true }> => p.assigned);
  const membership = sortMembership([...kept, ...added.map((p) => p.row)]);
  return { albums: withCounts(state.albums, membership), membership };
}

/**
 * Realizes an `after` placement set against the backend, reading `before` for where a track leaves
 * from. A track going loose is removed from its prior album; a track landing in one is moved there,
 * then its exact position and keep-own-cover flag are stamped, so an undo puts it back in its old slot
 * even from loose, where a re-add alone appends it last with the flag cleared. Only membership is
 * written: the track's title, artist and disc edits live in track_edits and follow it untouched.
 */
async function transitionToIpc(before: Placement[], after: Placement[]): Promise<void> {
  const priorAlbum = new Map<number, number>();
  for (const p of before) {
    if (p.assigned) priorAlbum.set(p.row.track_id, p.row.album_id);
  }

  for (const p of after) {
    if (p.assigned) continue;
    const from = priorAlbum.get(p.trackId);
    if (from !== undefined) await removeTracksFromAlbum(from, [p.trackId]);
  }

  for (const p of after) {
    if (!p.assigned) continue;
    await addTracksToAlbum(p.row.album_id, [p.row.track_id]);
    await setMemberPlacement(p.row.album_id, p.row.track_id, p.row.track_no, p.row.keep_own_cover);
  }
}

// ---- Projection helpers ----

const placementTrackId = (p: Placement): number => (p.assigned ? p.row.track_id : p.trackId);

// Loose rows never sort in; MAX_SAFE_INTEGER parks a null track_no last, matching the backend order.
const trackNoKey = (r: AlbumTrackRow): number => r.track_no ?? Number.MAX_SAFE_INTEGER;

// An unset disc numbers with disc 1, so it sorts there rather than parking a null last.
const discKey = (r: AlbumTrackRow): number => r.disc_no ?? 1;

/** Orders membership by album, then disc, then track number, grouping each album's discs in turn. */
function sortMembership(rows: AlbumTrackRow[]): AlbumTrackRow[] {
  return [...rows].sort(
    (a, b) => a.album_id - b.album_id || discKey(a) - discKey(b) || trackNoKey(a) - trackNoKey(b),
  );
}

/** Recomputes each album's track_count from the membership, reusing the album ref when unchanged. */
function withCounts(albums: AlbumRow[], membership: AlbumTrackRow[]): AlbumRow[] {
  const counts = new Map<number, number>();
  for (const r of membership) counts.set(r.album_id, (counts.get(r.album_id) ?? 0) + 1);
  return albums.map((a) => {
    const count = counts.get(a.id) ?? 0;
    return count === a.track_count ? a : { ...a, track_count: count };
  });
}
