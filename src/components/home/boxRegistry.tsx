/*
 * The Home box registry: each box type wired to the component that reads its own query and renders a
 * stat or preview shape. The catalog holds the sizes and mode membership; this holds the components, so
 * a new box type is one catalog entry plus one entry here - the grid places whatever the seed names and
 * never learns a box's data. Every box takes the shared nav callback and routes to its own destination.
 */

// -- Framework Imports --
import { useMemo } from "react";

// -- Component Imports --
import { StatBox } from "./StatBox";
import { PreviewBox } from "./PreviewBox";
import { SuggestionBox } from "./SuggestionBox";

// -- Unit Imports --
import {
  countMissingMetadata,
  pickPlayNext,
  topArtistFrom,
  tracksByArtist,
} from "./homeSuggestions";
import { resolveFacet } from "../tracks/trackFacets";

// -- State Imports --
import { useNeedsCoverCount } from "../../state/covers/store";
import { useAlbumIndex, useAlbumTracks, useMembership, useUnsortedTracks } from "../../state/organize/store";
import { useMostPlayed, useRecentlyPlayed } from "../../state/player/playHistory";
import { usePlayerActions, usePlayerEnabled } from "../../state/player/store";
import { useSetHistoryLens } from "../../state/shell/store";
import { useSetLibraryFacets, useSetLibraryMissingMetadata, useTracks } from "../../state/store";

// -- Type Imports --
import type { BoxType } from "./boxCatalog";
import type { Mode } from "../shell/navVisibility";
import type { TrackRow } from "../../types";
import type { ReactNode } from "react";

// -- i18n Imports --
import { useT } from "../../i18n";

/** How many rows a preview asks for; the box shows only as many as its measured width fits. */
const PREVIEW_LIMIT = 12;

/** The props every box takes: the one nav path the whole landing shares. */
export interface HomeBoxProps {
  onNavigate: (mode: Mode) => void;
}

/**
 * The play handler for a preview, or undefined when the player is off. Plays the one clicked track on
 * its own, the source carrying its title for the "playing from" line.
 */
function usePreviewPlay(): ((track: TrackRow) => void) | undefined {
  const enabled = usePlayerEnabled();
  const { play } = usePlayerActions();
  if (!enabled) return undefined;
  return (track) => {
    const label = track.title_edit ?? track.raw_title ?? track.filename;
    play([track.id], 0, { kind: "single", id: track.id, label });
  };
}

function MissingCoversBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const count = useNeedsCoverCount();
  return (
    <StatBox
      label={t((d) => d.home.missingCoversLabel)}
      count={count}
      verb={t((d) => d.home.missingCoversVerb)}
      settled={t((d) => d.home.missingCoversSettled)}
      onClick={() => onNavigate("covers")}
    />
  );
}

function UnsortedStatBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const count = useUnsortedTracks().length;
  return (
    <StatBox
      label={t((d) => d.home.unsortedLabel)}
      count={count}
      verb={t((d) => d.home.unsortedVerb)}
      settled={t((d) => d.home.unsortedSettled)}
      onClick={() => onNavigate("unsorted")}
    />
  );
}

function UnsortedPreviewBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const rows = useUnsortedTracks().slice(0, PREVIEW_LIMIT);
  const onPlay = usePreviewPlay();
  return (
    <PreviewBox
      label={t((d) => d.home.unsortedLabel)}
      rows={rows}
      invite={t((d) => d.home.unsortedInvite)}
      seeAllLabel={t((d) => d.home.seeAll)}
      onSeeAll={() => onNavigate("unsorted")}
      onPlay={onPlay}
    />
  );
}

function RecentlyPlayedBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const rows = useRecentlyPlayed(PREVIEW_LIMIT);
  const onPlay = usePreviewPlay();
  const setHistoryLens = useSetHistoryLens();
  return (
    <PreviewBox
      label={t((d) => d.home.recentlyPlayedLabel)}
      rows={rows}
      invite={t((d) => d.home.playInvite)}
      seeAllLabel={t((d) => d.home.seeAll)}
      // See-all lands on History under the matching lens; set it before the nav so the destination
      // seeds onto it.
      onSeeAll={() => {
        setHistoryLens("recent");
        onNavigate("history");
      }}
      onPlay={onPlay}
    />
  );
}

function MostPlayedBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const rows = useMostPlayed(PREVIEW_LIMIT);
  const onPlay = usePreviewPlay();
  const setHistoryLens = useSetHistoryLens();
  return (
    <PreviewBox
      label={t((d) => d.home.mostPlayedLabel)}
      rows={rows}
      invite={t((d) => d.home.playInvite)}
      seeAllLabel={t((d) => d.home.seeAll)}
      onSeeAll={() => {
        setHistoryLens("most");
        onNavigate("history");
      }}
      onPlay={onPlay}
    />
  );
}

function MissingMetadataBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const count = countMissingMetadata(useTracks(), useAlbumIndex());
  const setMissingMetadata = useSetLibraryMissingMetadata();
  return (
    <StatBox
      label={t((d) => d.home.missingMetaLabel)}
      count={count}
      verb={t((d) => d.home.missingMetaVerb)}
      settled={t((d) => d.home.missingMetaSettled)}
      // Land on All Tracks already narrowed to these tracks, the chip naming why.
      onClick={() => {
        setMissingMetadata(true);
        onNavigate("tracks");
      }}
    />
  );
}

function PlayNextBox(_: HomeBoxProps) {
  const t = useT();
  const tracks = useTracks();
  const recent = useRecentlyPlayed(PREVIEW_LIMIT);
  const seed = recent[0] ?? null;
  // Locate the seed's album so the album-next branch can walk it; -1 stands in when the seed is loose,
  // which yields no membership rows.
  const membership = useMembership();
  const albumId = seed ? membership.find((r) => r.track_id === seed.id)?.album_id : undefined;
  const albumTracks = useAlbumTracks(albumId ?? -1);
  const albumIndex = useAlbumIndex();
  const onPlay = usePreviewPlay();

  const suggestion = useMemo(() => {
    if (!seed) return null;
    const byId = new Map(tracks.map((row) => [row.id, row] as const));
    const seedAlbumTracks = albumTracks
      .map((r) => byId.get(r.track_id))
      .filter((row): row is TrackRow => row != null);
    const artist = resolveFacet(seed, "artist");
    const artistTracks = artist ? tracksByArtist(tracks, artist, tracks.length, [seed.id]) : [];
    return pickPlayNext(seed, seedAlbumTracks, artistTracks, recent.map((r) => r.id), albumIndex);
  }, [seed, tracks, albumTracks, recent, albumIndex]);

  // The why-line: the album continuation or the artist fallback, each named. An empty name yields no
  // line rather than a bare "Next in".
  const reason = suggestion?.reason;
  const context =
    reason?.kind === "album" && reason.album
      ? t((d) => d.home.playNextInAlbum, { album: reason.album })
      : reason?.kind === "artist" && reason.artist
        ? t((d) => d.home.playNextFromArtist, { artist: reason.artist })
        : undefined;

  return (
    <SuggestionBox
      label={t((d) => d.home.playNextLabel)}
      track={suggestion?.track ?? null}
      context={context}
      invite={t((d) => d.home.playNextInvite)}
      onPlay={onPlay}
    />
  );
}

function MoreFromArtistBox({ onNavigate }: HomeBoxProps) {
  const t = useT();
  const tracks = useTracks();
  const artist = topArtistFrom(useMostPlayed(1));
  const setFacets = useSetLibraryFacets();
  const onPlay = usePreviewPlay();

  const rows = useMemo(
    () => (artist ? tracksByArtist(tracks, artist, PREVIEW_LIMIT) : []),
    [tracks, artist],
  );

  return (
    <PreviewBox
      label={artist ? t((d) => d.home.moreFromArtistNamed, { artist }) : t((d) => d.home.moreFromArtistLabel)}
      rows={rows}
      invite={t((d) => d.home.moreFromArtistInvite)}
      seeAllLabel={artist ? t((d) => d.home.seeAll) : undefined}
      onSeeAll={
        artist
          ? () => {
              setFacets([{ facet: "artist", value: artist }]);
              onNavigate("tracks");
            }
          : undefined
      }
      onPlay={onPlay}
    />
  );
}

/** Each box type's component. The single point to extend alongside its catalog entry. */
export const BOX_COMPONENTS: Record<BoxType, (props: HomeBoxProps) => ReactNode> = {
  missingCovers: MissingCoversBox,
  unsortedStat: UnsortedStatBox,
  unsortedPreview: UnsortedPreviewBox,
  recentlyPlayed: RecentlyPlayedBox,
  mostPlayed: MostPlayedBox,
  missingMetadata: MissingMetadataBox,
  playNext: PlayNextBox,
  moreFromArtist: MoreFromArtistBox,
};
