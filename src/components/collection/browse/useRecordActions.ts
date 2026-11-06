// -- State Imports --
import { useAlbumTracks } from "../../../state/organize/store";
import { usePlayerActions, usePlayerEnabled } from "../../../state/player/store";
import { useRouteCollection } from "../../../state/collection/store";

// -- Utils Imports --
import { sourceForContainer } from "../../albums/playbackSource";

// -- Type Imports --
import type { AlbumRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

export interface RecordActions {
  /** Plays the record from its first track. */
  play: () => void;
  /** Hands the record to its flat wall, which lands on it with its drawer open. */
  open: () => void;
  /** Enter and Space: play, or open the record on its wall where play is off. */
  activate: () => void;
}

/** What the focused record can do. A null album makes every action a no-op. */
export function useRecordActions(album: AlbumRow | null): RecordActions {
  const t = useT();
  const tracks = useAlbumTracks(album?.id ?? -1);
  const { play } = usePlayerActions();
  const playerEnabled = usePlayerEnabled();
  const route = useRouteCollection();

  const playRecord = () => {
    if (!album || tracks.length === 0) return;
    const source = sourceForContainer(album, t((d) => d.albums.untitled));
    play(
      tracks.map((track) => track.track_id),
      0,
      source,
    );
  };

  const open = () => {
    if (!album) return;
    route({
      segment: album.kind === "single" ? "singles" : "albums",
      handoff: { albumId: album.id, how: "open" },
    });
  };

  return { play: playRecord, open, activate: playerEnabled ? playRecord : open };
}
