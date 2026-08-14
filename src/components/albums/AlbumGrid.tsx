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
 * The album grid: an auto-filling wall of cards on the bespoke scroll surface. With no albums yet it
 * shows the quiet on-ramp pointing at Files, where albums are made from a track selection.
 * Selection and the drawer are the parent's concern; this lays out the cards and reports opens.
 */
export function AlbumGrid({
  albums,
  selectedAlbumId,
  onOpen,
}: {
  albums: AlbumRow[];
  selectedAlbumId: number | null;
  onOpen: (albumId: number) => void;
}) {
  const t = useT();

  if (albums.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState
          tone="idle"
          title={t((d) => d.albums.emptyTitle)}
          line={t((d) => d.albums.emptyLine)}
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
          onOpen={onOpen}
        />
      ))}
    </ScrollArea>
  );
}
