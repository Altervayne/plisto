// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import { useAppStore } from "../../state/store";
import { useOrganizeStore } from "../../state/organize/store";
import { usePlaylistsStore } from "../../state/playlists/store";
import { useAppMode } from "../../state/player/store";

// -- Utils Imports --
import { buildFinderIndex, destinationEntries, finderDestinations } from "./finderIndex";
import { DESTINATION_LABEL } from "./finderDestinations";

// -- Type Imports --
import type { DestinationEntry, FinderIndex, FinderSource } from "./finderIndex";

// -- i18n Imports --
import { createT, useLocale } from "../../i18n";

// The last build and the rows it came from. The finder mounts on each open, so a component memo would
// rebuild every time; this survives the unmount and rebuilds only when a source row list changes.
let cached: { source: FinderSource; index: FinderIndex } | null = null;

function sameSource(a: FinderSource, b: FinderSource): boolean {
  return (Object.keys(a) as (keyof FinderSource)[]).every((key) => a[key] === b[key]);
}

function indexFor(source: FinderSource): FinderIndex {
  if (cached == null || !sameSource(cached.source, source)) {
    cached = { source, index: buildFinderIndex(source) };
  }
  return cached.index;
}

/** The library index over the live store rows, plus the destinations the current mode can reach. */
export function useFinderIndex(): { index: FinderIndex; destinations: DestinationEntry[] } {
  const tracks = useAppStore((s) => s.tracks);
  const albums = useOrganizeStore((s) => s.org.albums);
  const membership = useOrganizeStore((s) => s.org.membership);
  const genres = useOrganizeStore((s) => s.genres);
  const playlists = usePlaylistsStore((s) => s.playlists);
  const slots = usePlaylistsStore((s) => s.tracks);
  const appMode = useAppMode();
  const locale = useLocale();
  const t = useMemo(() => createT(locale), [locale]);
  const untitledAlbum = t((d) => d.albums.untitled);
  const untitledPlaylist = t((d) => d.playlists.untitled);

  const index = useMemo(
    () =>
      indexFor({
        tracks,
        albums,
        membership,
        playlists,
        slots,
        genres,
        untitledAlbum,
        untitledPlaylist,
      }),
    [tracks, albums, membership, playlists, slots, genres, untitledAlbum, untitledPlaylist],
  );

  const destinations = useMemo(
    () =>
      destinationEntries(
        finderDestinations(appMode).map((mode) => ({ mode, label: t(DESTINATION_LABEL[mode]) })),
      ),
    [appMode, t],
  );

  return { index, destinations };
}
