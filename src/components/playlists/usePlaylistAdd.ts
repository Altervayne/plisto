// -- State Imports --
import {
  useAddAlbumsToPlaylist,
  useAddTracksToPlaylist,
  usePlaylistsStore,
} from "../../state/playlists/store";
import { albumAdded } from "../../state/player/queueToast";

// -- i18n Imports --
import { useT } from "../../i18n";

/** What an Add to playlist hands over: whole albums, each one entry, or loose tracks. */
export type PlaylistAdd =
  | { kind: "albums"; albumIds: number[] }
  | { kind: "tracks"; trackIds: number[] };

/**
 * The write behind every album-surface Add to playlist. Albums go in as entries that keep their order
 * (the default for a new entry) and say so in a pill naming the playlist; tracks go in as slots, as every
 * track surface does. A single in an albums list still lands as a track slot: the store command decides.
 */
export function usePlaylistAdd(): (playlistId: number, add: PlaylistAdd) => Promise<void> {
  const addTracks = useAddTracksToPlaylist();
  const addAlbums = useAddAlbumsToPlaylist();
  const t = useT();
  const untitled = t((d) => d.playlists.untitled);

  // A rejected write is dropped like the player's transport calls: no unhandled rejection, no pill.
  return async (playlistId, add) => {
    try {
      if (add.kind === "tracks") {
        await addTracks(playlistId, add.trackIds);
        return;
      }
      await addAlbums(playlistId, add.albumIds, true);
    } catch {
      return;
    }
    const name = usePlaylistsStore.getState().playlists.find((p) => p.id === playlistId)?.name;
    albumAdded(name || untitled);
  };
}
