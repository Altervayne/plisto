// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { AlbumCard } from "./AlbumCard";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumGrid.module.css";

/**
 * The album grid: an auto-filling wall of cards on the bespoke scroll surface. With no cards yet it
 * shows the quiet on-ramp pointing at Files, where albums and singles are made from a track selection.
 * The empty copy defaults to the album on-ramp; the singles wall reuses the same layout with its own.
 * Selection and the drawer are the parent's concern; this lays out the cards and reports opens.
 */
export function AlbumGrid({
  albums,
  selectedAlbumId,
  onOpen,
  onOpenFull,
  emptyTitle,
  emptyLine,
}: {
  albums: AlbumRow[];
  selectedAlbumId: number | null;
  onOpen: (albumId: number) => void;
  onOpenFull?: (albumId: number) => void;
  emptyTitle?: string;
  emptyLine?: string;
}) {
  // A drawer being open means opening another won't reflow the grid, so the cards can skip the
  // double-click hold and act on the first click.
  const drawerOpen = selectedAlbumId != null;
  const t = useT();

  if (albums.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState
          tone="idle"
          title={emptyTitle ?? t((d) => d.albums.emptyTitle)}
          line={emptyLine ?? t((d) => d.albums.emptyLine)}
        />
      </div>
    );
  }

  return (
    <ScrollArea className={styles.scroll} contentClassName={styles.grid}>
      {albums.map((album) => (
        <AlbumCard
          key={album.id}
          album={album}
          selected={album.id === selectedAlbumId}
          drawerOpen={drawerOpen}
          onOpen={onOpen}
          onOpenFull={onOpenFull}
        />
      ))}
    </ScrollArea>
  );
}
