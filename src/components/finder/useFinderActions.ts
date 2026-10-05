// -- State Imports --
import {
  useRevealLibraryTrack,
  useSetLibraryFacets,
  useSetLibraryGone,
  useSetLibraryMissingMetadata,
  useSetLibrarySearch,
} from "../../state/store";
import { usePlayerActions } from "../../state/player/store";
import { useOpenDuplicates } from "../../state/shell/store";

// -- Utils Imports --
import { sourceForContainer } from "../albums/playbackSource";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";
import type { Mode } from "../shell/navVisibility";
import type { GridFacet } from "../tracks/trackFacets";
import type { PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

/** The shell's navigation, handed in because the open panes live in the shell's own state. */
export interface FinderNav {
  go: (mode: Mode) => void;
  openAlbum: (albumId: number) => void;
  openSingle: (albumId: number) => void;
  openPlaylist: (playlistId: number) => void;
}

/** What the finder can do with an entry: go to it, play it, or queue it. */
export interface FinderActions {
  open: (entry: FinderEntry) => void;
  play: (entry: FinderEntry) => void;
  enqueue: (entry: FinderEntry) => void;
  showAllTracks: (query: string) => void;
}

/** Whether an entry plays: tracks and the containers that hold an ordered track list. */
export function isPlayable(entry: FinderEntry): boolean {
  return (
    entry.kind === "track" ||
    entry.kind === "album" ||
    entry.kind === "single" ||
    entry.kind === "playlist"
  );
}

/**
 * The finder's actions over the shell's navigation. A jump into All Tracks clears its search and every
 * narrowing first, so the view shows exactly what the entry stands for.
 */
export function useFinderActions(nav: FinderNav): FinderActions {
  const setFacets = useSetLibraryFacets();
  const setSearch = useSetLibrarySearch();
  const setMissing = useSetLibraryMissingMetadata();
  const setGone = useSetLibraryGone();
  const reveal = useRevealLibraryTrack();
  const { play, addToQueue } = usePlayerActions();
  const openDuplicates = useOpenDuplicates();
  const t = useT();

  const allTracks = (facets: GridFacet[], search = "") => {
    setFacets(facets);
    setSearch(search);
    setMissing(false);
    setGone(false);
    nav.go("tracks");
  };

  // The same tags a play carries from the entry's own surface: an album or playlist names itself, a
  // single names the Singles wall, and a lone track plays as a one-off.
  const sourceOf = (entry: FinderEntry): PlaybackSource | null => {
    switch (entry.kind) {
      case "album":
      case "single":
        return sourceForContainer(
          { id: entry.id, kind: entry.kind, title: entry.label },
          t((d) => d.albums.untitled),
        );
      case "playlist":
        return { kind: "playlist", id: entry.id, label: entry.label };
      case "track":
        return { kind: "single", id: entry.id, label: entry.label };
      default:
        return null;
    }
  };

  const open = (entry: FinderEntry) => {
    switch (entry.kind) {
      case "album":
        nav.openAlbum(entry.id);
        break;
      case "single":
        nav.openSingle(entry.id);
        break;
      case "playlist":
        nav.openPlaylist(entry.id);
        break;
      case "artist": {
        // A name only ever seen as an album artist has no track-artist chip to match, so it filters on
        // the album-artist facet. Every spelling goes in, so no variant drops out.
        const albumOnly = entry.role === "album";
        const spellings = albumOnly ? entry.albumSpellings : entry.trackSpellings;
        const facet = albumOnly ? "album_artist" : "artist";
        allTracks(spellings.map((value) => ({ facet, value })));
        break;
      }
      case "genre":
        allTracks([{ facet: "genre", value: entry.label }]);
        break;
      case "track":
        allTracks([]);
        reveal(entry.id);
        break;
      case "destination":
        // The duplicates sheet opens over wherever the finder was summoned.
        if (entry.id === "duplicates") openDuplicates();
        else nav.go(entry.id);
        break;
    }
  };

  return {
    open,
    play: (entry) => {
      const source = sourceOf(entry);
      if (source && entry.trackIds.length > 0) play(entry.trackIds, 0, source);
    },
    enqueue: (entry) => {
      const source = sourceOf(entry);
      if (source && entry.trackIds.length > 0) addToQueue(entry.trackIds, source);
    },
    showAllTracks: (query) => allTracks([], query),
  };
}
