// -- Framework Imports --
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

// -- Library Imports --
import { useVirtualizer } from "@tanstack/react-virtual";

// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { AlbumCard } from "./AlbumCard";
import { PlaylistPicker } from "../playlists/PlaylistPicker";

// -- State Imports --
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  usePlaylists,
} from "../../state/playlists/store";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumGrid.module.css";

// The tile track and the gaps, mirrored from AlbumGrid.module.css: the column count follows the
// viewport width the same way the CSS auto-fill did, and the row estimate seeds the virtualizer before
// each row measures itself.
const TILE_WIDTH = 168;
const COL_GAP = 20;
const PAD_X = 22;
const ROW_ESTIMATE = 256;

/** How many fixed tiles fit across `inner` content pixels, at least one. */
function columnsFor(inner: number): number {
  return Math.max(1, Math.floor((inner + COL_GAP) / (TILE_WIDTH + COL_GAP)));
}

/**
 * The album grid: an auto-filling wall of cards on the bespoke scroll surface, windowed by row so only
 * the visible tiles mount and each fires its cover load once it scrolls in. With no cards yet it shows
 * the quiet on-ramp pointing at Files, where albums and singles are made from a track selection. The
 * empty copy defaults to the album on-ramp; the singles wall reuses the same layout with its own.
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
  const t = useT();

  // The add-to-playlist picker is shared by every card here: a card's right-click hands up its track
  // ids, which hold while the picker is open so a choose or create lands on that album's tracks.
  const playlists = usePlaylists();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const [playlistTarget, setPlaylistTarget] = useState<number[] | null>(null);

  // The column count tracks the viewport width, so opening the drawer beside the grid drops a column
  // rather than squishing the tiles, exactly as the CSS auto-fill did.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setColumns(columnsFor(el.clientWidth - PAD_X * 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Chunk the wall into rows of the current column count, then virtualize the rows: one virtual item
  // per row, each rendered as a grid line of its cards.
  const rows = useMemo(() => {
    const out: AlbumRow[][] = [];
    for (let i = 0; i < albums.length; i += columns) out.push(albums.slice(i, i + columns));
    return out;
  }, [albums, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 3,
  });

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
    <>
      <ScrollArea className={styles.scroll} contentClassName={styles.canvas} viewportRef={viewportRef}>
        <div
          className={styles.spacer}
          style={{ height: virtualizer.getTotalSize(), "--album-cols": columns } as CSSProperties}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              className={styles.row}
              ref={virtualizer.measureElement}
              data-index={item.index}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {rows[item.index].map((album) => (
                <AlbumCard
                  key={album.id}
                  album={album}
                  selected={album.id === selectedAlbumId}
                  onOpen={onOpen}
                  onOpenFull={onOpenFull}
                  onAddToPlaylist={setPlaylistTarget}
                />
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>

      {playlistTarget ? (
        <PlaylistPicker
          playlists={playlists}
          onChoose={(playlistId) => {
            void addTracksToPlaylist(playlistId, playlistTarget);
            setPlaylistTarget(null);
          }}
          onCreate={(name) => {
            const targets = playlistTarget;
            void (async () => {
              const playlistId = await createPlaylist(name);
              await addTracksToPlaylist(playlistId, targets);
            })();
            setPlaylistTarget(null);
          }}
          onClose={() => setPlaylistTarget(null)}
        />
      ) : null}
    </>
  );
}
