/*
 * A playlist's expansion read off the live stores: its slots and album entries from the playlists store,
 * the album members and the loaded flag from the organize store. Kept apart from the playlists store so
 * that store never imports the organize one. Counts derive here, not from the stored `track_count`,
 * because an organize edit changes what an album entry holds without reloading playlists.
 */

// -- Library Imports --
import { useMemo } from "react";

// -- State Imports --
import { useMembership, useOrgReady } from "../organize/store";
import { usePlaylist, usePlaylistAlbumEntries, usePlaylistTracks } from "./store";

// -- Utils Imports --
import { expandPlaylist, groupMembers } from "../../components/playlists/playlistExpand";

// -- Type Imports --
import type { PlaylistEntry, PlaylistExpansion } from "../../components/playlists/playlistExpand";

/** One playlist expanded over the live rows, memoized on the rows it reads. */
export function usePlaylistExpansion(playlistId: number): PlaylistExpansion {
  const slots = usePlaylistTracks(playlistId);
  const entries = usePlaylistAlbumEntries(playlistId);
  const membership = useMembership();
  const orgReady = useOrgReady();
  const members = useMemo(() => groupMembers(membership), [membership]);
  return useMemo(
    () => expandPlaylist(slots, entries, members, { orgReady }),
    [slots, entries, members, orgReady],
  );
}

/** One playlist's rows in order, track slots and album entries merged. */
export const usePlaylistEntries = (playlistId: number): PlaylistEntry[] =>
  usePlaylistExpansion(playlistId).entries;

/**
 * The playlist's track count: its slots plus the members of every album entry. While the album
 * projection is not loaded it holds the count the playlists load reported, never 0.
 */
export function usePlaylistTrackCount(playlistId: number): number {
  const expansion = usePlaylistExpansion(playlistId);
  return trackCountOf(expansion, usePlaylist(playlistId)?.track_count ?? 0);
}

/** The derived count when the expansion is ready, else the count the playlists load reported. */
export function trackCountOf(expansion: PlaylistExpansion, loaded: number): number {
  return expansion.count ?? loaded;
}
