// -- State Imports --
import { usePlaylist, usePlaylistTracks } from "../../state/playlists/store";
import { usePlayerActions } from "../../state/player/store";

// -- Utils Imports --
import { hasPlayableSlot, playlistQueue } from "./playlistPlayback";

// -- Type Imports --
import type { PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

/** A whole-playlist play: whether anything can play, and the play and append actions. */
export interface PlaylistPlayback {
  playable: boolean;
  play: () => void;
  addToQueue: () => void;
}

/**
 * Plays a whole playlist from its first slot, tagged with the playlist as the source like a per-track
 * play from its list. The store already holds every playlist's slots, so no load runs here.
 */
export function usePlayPlaylist(playlistId: number): PlaylistPlayback {
  const slots = usePlaylistTracks(playlistId);
  const playlist = usePlaylist(playlistId);
  const actions = usePlayerActions();
  const t = useT();

  const source: PlaybackSource = {
    kind: "playlist",
    id: playlistId,
    label: playlist?.name ?? t((d) => d.playlists.untitled),
  };

  return {
    playable: hasPlayableSlot(slots),
    play: () => actions.play(playlistQueue(slots), 0, source),
    addToQueue: () => actions.addToQueue(playlistQueue(slots), source),
  };
}
