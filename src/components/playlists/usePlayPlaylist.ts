// -- State Imports --
import { usePlaylist } from "../../state/playlists/store";
import { usePlaylistExpansion } from "../../state/playlists/expansion";
import { usePlayerActions } from "../../state/player/store";
import { announceAfterBlock } from "../../state/player/queueToast";

// -- Utils Imports --
import { hasPlayableSlot } from "./playlistPlayback";

// -- Type Imports --
import type { PlaybackSource } from "../../types";
import type { PlaylistExpansion } from "./playlistExpand";

// -- i18n Imports --
import { useT } from "../../i18n";

/** A whole-playlist play: whether anything can play, and the play and append actions. */
export interface PlaylistPlayback {
  playable: boolean;
  play: () => void;
  playNext: () => void;
  addToQueue: () => void;
}

/** The play controls over an expansion. Not ready is not playable and every action is a no-op. */
export function playbackOf(
  { entries, ids, blocks, ready }: PlaylistExpansion,
  actions: Pick<ReturnType<typeof usePlayerActions>, "play" | "playNext" | "addToQueue">,
  source: PlaybackSource,
): PlaylistPlayback {
  return {
    playable: ready && hasPlayableSlot(entries),
    play: () => {
      if (ready) actions.play(ids, 0, source, blocks);
    },
    playNext: () => {
      if (ready) announceAfterBlock(actions.playNext(ids, source, blocks));
    },
    addToQueue: () => {
      if (ready) actions.addToQueue(ids, source, blocks);
    },
  };
}

/**
 * Plays a whole playlist from its first row, tagged with the playlist as the source like a per-track
 * play from its list. An album entry plays its members, a kept one as a block. The store already holds
 * every playlist's rows, so no load runs here. While the album projection is loading the play is not
 * playable and the actions do nothing: a partial queue is never sent.
 */
export function usePlayPlaylist(playlistId: number): PlaylistPlayback {
  const expansion = usePlaylistExpansion(playlistId);
  const playlist = usePlaylist(playlistId);
  const actions = usePlayerActions();
  const t = useT();

  const source: PlaybackSource = {
    kind: "playlist",
    id: playlistId,
    label: playlist?.name ?? t((d) => d.playlists.untitled),
  };

  return playbackOf(expansion, actions, source);
}
