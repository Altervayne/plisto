// -- Framework Imports --
import { useMemo } from "react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";

// -- State Imports --
import { useOrganizeStore } from "../../../state/organize/store";
import { groupByAlbumTags } from "../../../state/organize/groupByAlbumTags";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { TrackRow } from "../../../types";

// -- Style Imports --
import styles from "./AlbumsFromTagsButton.module.css";

/**
 * The quiet entry to the albums-from-tags review, labelled with how many albums the loose tracks in
 * scope would make. Counts live, so it follows folder navigation, and hides itself at zero.
 */
export function AlbumsFromTagsButton({
  tracks,
  onOpen,
}: {
  tracks: TrackRow[];
  onOpen: () => void;
}) {
  const t = useT();
  const albums = useOrganizeStore((s) => s.org.albums);
  const membership = useOrganizeStore((s) => s.org.membership);
  const count = useMemo(
    () => groupByAlbumTags(tracks, albums, membership).proposals.length,
    [tracks, albums, membership],
  );

  if (count === 0) return null;

  return (
    <QuietButton onClick={onOpen}>
      {t((d) => d.tagAlbums.entry)}
      <span className={styles.count}>{t((d) => d.tagAlbums.count, { n: count })}</span>
    </QuietButton>
  );
}
