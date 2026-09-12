/*
 * The Home box registry: each box type wired to the component that reads its own query and renders a
 * stat or preview shape. The catalog holds the sizes and mode membership; this holds the components, so
 * a new box type is one catalog entry plus one entry here - the grid places whatever the seed names and
 * never learns a box's data. Every box takes the shared nav callback and routes to its own destination.
 */

// -- Component Imports --
import { StatBox } from "./StatBox";
import { PreviewBox } from "./PreviewBox";

// -- State Imports --
import { useNeedsCoverCount } from "../../state/covers/store";
import { useUnsortedTracks } from "../../state/organize/store";
import { useMostPlayed, useRecentlyPlayed } from "../../state/player/playHistory";
import { usePlayerActions, usePlayerEnabled } from "../../state/player/store";

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

function RecentlyPlayedBox(_: HomeBoxProps) {
  const t = useT();
  const rows = useRecentlyPlayed(PREVIEW_LIMIT);
  const onPlay = usePreviewPlay();
  return (
    <PreviewBox
      label={t((d) => d.home.recentlyPlayedLabel)}
      rows={rows}
      invite={t((d) => d.home.playInvite)}
      onPlay={onPlay}
    />
  );
}

function MostPlayedBox(_: HomeBoxProps) {
  const t = useT();
  const rows = useMostPlayed(PREVIEW_LIMIT);
  const onPlay = usePreviewPlay();
  return (
    <PreviewBox
      label={t((d) => d.home.mostPlayedLabel)}
      rows={rows}
      invite={t((d) => d.home.playInvite)}
      onPlay={onPlay}
    />
  );
}

/** Each box type's component. The single point H3 extends alongside its catalog entry. */
export const BOX_COMPONENTS: Record<BoxType, (props: HomeBoxProps) => ReactNode> = {
  missingCovers: MissingCoversBox,
  unsortedStat: UnsortedStatBox,
  unsortedPreview: UnsortedPreviewBox,
  recentlyPlayed: RecentlyPlayedBox,
  mostPlayed: MostPlayedBox,
};
