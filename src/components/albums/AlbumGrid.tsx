// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { AlbumCard } from "./AlbumCard";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- Style Imports --
import styles from "./AlbumGrid.module.css";

/**
 * The album grid: an auto-filling wall of cards on the bespoke scroll surface. With no albums yet it
 * shows the quiet on-ramp pointing at the List view, where albums are made from a track selection.
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
  if (albums.length === 0) {
    return (
      <EmptyState
        tone="idle"
        title="No albums yet"
        line="Switch to List, select tracks, and Create album."
      />
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
