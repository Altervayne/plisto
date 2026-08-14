/*
 * The organize command engine: a pure, framework-free inverse-command stack over the album/membership
 * projection. Every undoable edit is a Command that captures its target, its next value, and enough of
 * the previous state to build a clean inverse. applyCommand is the pure reducer, invertCommand builds
 * the exact reverse, and commandToIpc is the thin write sink an undo reuses (the inverse is itself a
 * Command). The membership moves (assign/unassign) carry the full before/after rows so a single inverse
 * Command restores a moved track exactly - the backend resets numbering and clears overrides on a move,
 * so the prior row must travel with the command, not be recomputed.
 */

// -- IPC Imports --
import {
  addTracksToAlbum,
  removeTracksFromAlbum,
  setAlbumFields as ipcSetAlbumFields,
  setTrackOrder,
  setTrackOverrides as ipcSetTrackOverrides,
} from "../../lib/ipc";

// -- Type Imports --
import type { AlbumFields, AlbumRow, AlbumTrackRow, TrackOverride } from "../../types";

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

/** Rewrites an album's track order (track_ids in the new sequence); `prevOrder` restores it. */
export interface ReorderTracks {
  kind: "reorderTracks";
  albumId: number;
  nextOrder: number[];
  prevOrder: number[];
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

/** The five undoable in-place edits. Create, delete and cover-set are structural, not on this stack. */
export type Command =
  | SetAlbumFields
  | SetTrackOverrides
  | ReorderTracks
  | AssignTracks
  | UnassignTracks;

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

    case "reorderTracks": {
      const position = new Map(cmd.nextOrder.map((id, i) => [id, i + 1]));
      const membership = state.membership.map((r) =>
        r.album_id === cmd.albumId && position.has(r.track_id)
          ? { ...r, track_no: position.get(r.track_id)! }
          : r,
      );
      return { albums: state.albums, membership: sortMembership(membership) };
    }

    case "assign":
    case "unassign":
      return applyTransition(state, cmd.after);
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

    case "reorderTracks":
      return {
        kind: "reorderTracks",
        albumId: cmd.albumId,
        nextOrder: cmd.prevOrder,
        prevOrder: cmd.nextOrder,
      };

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

    case "reorderTracks":
      await setTrackOrder(cmd.albumId, cmd.nextOrder);
      return;

    case "assign":
    case "unassign":
      await transitionToIpc(cmd.before, cmd.after);
      return;
  }
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
 * then its exact numbering and overrides are stamped (a move alone appends and clears them).
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
    await ipcSetTrackOverrides(p.row.album_id, p.row.track_id, {
      title_override: p.row.title_override,
      artist_override: p.row.artist_override,
      track_no: p.row.track_no,
      disc_no: p.row.disc_no,
    });
  }
}

// ---- Projection helpers ----

const placementTrackId = (p: Placement): number => (p.assigned ? p.row.track_id : p.trackId);

// Loose rows never sort in; MAX_SAFE_INTEGER parks a null track_no last, matching the backend order.
const trackNoKey = (r: AlbumTrackRow): number => r.track_no ?? Number.MAX_SAFE_INTEGER;

/** Orders membership by album then track number, the same shape load_organization returns. */
function sortMembership(rows: AlbumTrackRow[]): AlbumTrackRow[] {
  return [...rows].sort((a, b) => a.album_id - b.album_id || trackNoKey(a) - trackNoKey(b));
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
