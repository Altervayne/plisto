// -- State Imports --
import { useAlbumTracks } from "../../../state/organize/store";
import { usePlayerActions, usePlayerEnabled } from "../../../state/player/store";
import { useRouteCollection } from "../../../state/collection/store";

// -- Utils Imports --
import { sourceForContainer } from "../../albums/playbackSource";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

export interface RecordActions {
  /** Plays the record from its first track. */
  play: () => void;
  /** Plays the record from the track at `index` in its disc-then-number order. */
  playFrom: (index: number) => void;
  playNext: () => void;
  addToQueue: () => void;
  /** Hands the record to its flat wall, which lands on it with its drawer open. */
  open: () => void;
  /** Hands the record to its flat wall, which lands on it pre-ticked with the selection bar up. */
  select: () => void;
  /** Enter and Space: play, or open the record on its wall where play is off. */
  activate: () => void;
  /** The record's tracks in play order: disc, then number. */
  tracks: AlbumTrackRow[];
}

/** What the focused record can do. A null album makes every action a no-op. */
export function useRecordActions(album: AlbumRow | null): RecordActions {
  const t = useT();
  const tracks = useAlbumTracks(album?.id ?? -1);
  const { play, playNext, addToQueue } = usePlayerActions();
  const playerEnabled = usePlayerEnabled();
  const route = useRouteCollection();
  const trackIds = tracks.map((track) => track.track_id);
  const source = album ? sourceForContainer(album, t((d) => d.albums.untitled)) : null;

  const playFrom = (index: number) => {
    if (!source || trackIds.length === 0) return;
    play(trackIds, Math.max(0, Math.min(index, trackIds.length - 1)), source);
  };

  const handTo = (how: "open" | "select") => {
    if (!album) return;
    route({
      segment: album.kind === "single" ? "singles" : "albums",
      handoff: { albumId: album.id, how },
    });
  };

  const playRecord = () => playFrom(0);
  const open = () => handTo("open");

  return {
    play: playRecord,
    playFrom,
    playNext: () => {
      if (source && trackIds.length > 0) playNext(trackIds, source);
    },
    addToQueue: () => {
      if (source && trackIds.length > 0) addToQueue(trackIds, source);
    },
    open,
    select: () => handTo("select"),
    activate: playerEnabled ? playRecord : open,
    tracks,
  };
}
