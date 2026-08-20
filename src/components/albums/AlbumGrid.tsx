// -- Framework Imports --
import { useCallback, useMemo, useRef, useState } from "react";

// -- Icon Imports --
import { ArrowRight } from "lucide-react";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SegmentedControl } from "../common/SegmentedControl";
import { DateRangePicker } from "../common/DateRangePicker/DateRangePicker";
import { AlbumCard } from "./AlbumCard";
import { AlbumExportDialog } from "./AlbumExportDialog";
import { PlaylistPicker } from "../playlists/PlaylistPicker";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  usePlaylists,
} from "../../state/playlists/store";

// -- Type Imports --
import type { AlbumRow } from "../../types";
import type { DateRange } from "../common/DateRangePicker/DateRangePicker";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumGrid.module.css";

/** The selection bar's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

/**
 * The album grid: a wall of fixed-width cards that wraps to the content width, on the bespoke scroll
 * surface. One flex row that wraps, so opening the detail drawer beside the grid simply drops a column as
 * the space narrows - the cards never resize, and each keeps its identity across the reflow, so its cover
 * holds rather than reloading. Off-screen covers stay cheap: the Cover atom loads its art lazily, only
 * fetching as a tile nears the viewport, and each card is memoized so an unrelated re-render never touches
 * the whole wall. With no cards yet it shows the quiet on-ramp pointing at Files, where albums and singles
 * are made from a track selection; the singles wall reuses this layout with its own copy. The open drawer
 * is the parent's concern; the multi-select and its floating export bar live here - a modified click
 * (ctrl/cmd toggle, shift range) picks cards, and the bar hands the picked ids to the selection export modal.
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

  // The view filter: which stamp to test and the range to keep. Both live here, so the two walls reset
  // them on their own remount, the same way the multi-selection resets. An empty range shows everything.
  const [dateField, setDateField] = useState<"created" | "updated">("updated");
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const visible = useMemo(() => {
    if (range.from == null && range.to == null) return albums;
    return albums.filter((album) => {
      const stamp = dateField === "created" ? album.created_at : album.updated_at;
      if (range.from != null && stamp < range.from) return false;
      if (range.to != null && stamp > range.to) return false;
      return true;
    });
  }, [albums, dateField, range]);

  // The add-to-playlist picker is shared by every card here: a card's right-click hands up its track
  // ids, which hold while the picker is open so a choose or create lands on that album's tracks.
  const playlists = usePlaylists();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const [playlistTarget, setPlaylistTarget] = useState<number[] | null>(null);

  // The ids a selection export is opened over: the whole picked set from the bar, or one album from a
  // card's own Export. Null keeps the modal closed.
  const [exportIds, setExportIds] = useState<number[] | null>(null);

  // Multi-selection keyed by album id, with the anchor held as an index into the current visual order so
  // a shift-range respects the wall as it reads on screen. The two walls remount this grid, so the set
  // resets on its own when the wall changes - no cross-wall bleed to guard.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchorRef = useRef<number | null>(null);

  // A plain open drops the multi-selection: the drawer and the pick are separate gestures. The functional
  // update keeps the same set when it is already empty, so an ordinary open never re-renders the wall.
  const handleOpen = useCallback(
    (albumId: number) => {
      setSelected((prev) => (prev.size > 0 ? new Set<number>() : prev));
      onOpen(albumId);
    },
    [onOpen],
  );

  const handleToggleSelect = useCallback(
    (albumId: number, mods: { meta: boolean; shift: boolean }) => {
      const index = visible.findIndex((a) => a.id === albumId);
      if (mods.shift && anchorRef.current != null) {
        const anchor = anchorRef.current;
        const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
        setSelected((prev) => {
          const next = new Set(prev);
          for (const album of visible.slice(lo, hi + 1)) next.add(album.id);
          return next;
        });
        return;
      }
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(albumId)) next.delete(albumId);
        else next.add(albumId);
        return next;
      });
      anchorRef.current = index;
    },
    [visible],
  );

  // A card's own Export opens the modal over just that album - a one-item run through the same modal the
  // bar opens for the whole set.
  const handleExport = useCallback((albumId: number) => setExportIds([albumId]), []);

  // Hold the bar through its exit after the set empties, keeping the last count so the fade shows the
  // tally it had rather than a bare zero.
  const bar = useMountTransition(selected.size > 0, EXIT_MS);
  const lastCount = useRef(0);
  if (selected.size > 0) lastCount.current = selected.size;

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
      <div className={styles.wall}>
        <div className={styles.toolbar}>
          <SegmentedControl
            segments={[
              { value: "created", label: t((d) => d.albums.dateCreated) },
              { value: "updated", label: t((d) => d.albums.dateUpdated) },
            ]}
            value={dateField}
            onChange={setDateField}
            label={t((d) => d.albums.dateField)}
          />
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        {visible.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState tone="idle" title={t((d) => d.albums.noDateMatch)} line="" />
          </div>
        ) : (
          <ScrollArea className={styles.scroll} contentClassName={styles.canvas}>
            <div className={styles.grid}>
              {visible.map((album) => (
                <AlbumCard
                  key={album.id}
                  album={album}
                  selected={album.id === selectedAlbumId}
                  checked={selected.has(album.id)}
                  onOpen={handleOpen}
                  onOpenFull={onOpenFull}
                  onToggleSelect={handleToggleSelect}
                  onExport={handleExport}
                  onAddToPlaylist={setPlaylistTarget}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {bar.mounted ? (
        <div
          className={styles.bar}
          data-state={bar.state}
          role="toolbar"
          aria-label={t((d) => d.albums.exportSelected)}
        >
          <span className={styles.summary}>
            {t((d) => d.albums.gridSelected, { n: lastCount.current })}
          </span>
          <div className={styles.actions}>
            <PrimaryButton onClick={() => setExportIds([...selected])}>
              {t((d) => d.albums.exportSelected)}
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </PrimaryButton>
            <QuietButton onClick={() => setSelected(new Set())}>
              {t((d) => d.common.clear)}
            </QuietButton>
          </div>
        </div>
      ) : null}

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

      {exportIds ? (
        <AlbumExportDialog albumIds={exportIds} onClose={() => setExportIds(null)} />
      ) : null}
    </>
  );
}
