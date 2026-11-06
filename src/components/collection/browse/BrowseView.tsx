// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

// -- Component Imports --
import { BrowseToolbar } from "./BrowseToolbar";
import { BrowseShelf } from "./BrowseShelf";
import { BrowseRail } from "./BrowseRail";
import { BrowseInfo } from "./BrowseInfo";
import { BrowseTrackList } from "./BrowseTrackList";
import { BrowseRecordMenu } from "./BrowseRecordMenu";
import { EmptyState } from "../../common/EmptyState";

// -- Hook Imports --
import { useRecordActions } from "./useRecordActions";

// -- State Imports --
import {
  ALL_KINDS,
  useBrowseFocusId,
  useBrowseGroupBy,
  useBrowseKinds,
  useFocusBrowse,
  useSetBrowseGroupBy,
  useToggleBrowseKind,
} from "../../../state/collection/store";
import { useGenres, useMembership } from "../../../state/organize/store";
import { useOrganizeEnabled, usePlayerEnabled } from "../../../state/player/store";

// -- Utils Imports --
import { browseOrder } from "./browseOrder";
import { isFarJump } from "./shelfLayout";
import { resolveFocus } from "./browseFocus";
import { groupLabelText } from "./groupLabelText";
import { recordLabel } from "./browseRecord";

// -- Type Imports --
import type { AlbumRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./BrowseView.module.css";

/** How long the focus rests before the live region names it, so a fast scrub reads only where it lands. */
const ANNOUNCE_MS = 250;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const readReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION).matches;

/**
 * The Browse segment: the toolbar, the shelf and its rail over every album and single, ordered by the
 * chips and the grouping. The focus is an album id in the collection store and resolves to an index in
 * the current order on every render, so a regroup or a rename keeps the same record; when it leaves the
 * order the record now at its old index takes the focus. Under the shelf sit the focused record's text, actions and track list; its menu hands it to
 * a wall or the queue. Reduced motion swaps the tilted shelf for a flat strip.
 */
export function BrowseView({ albums, singles }: { albums: AlbumRow[]; singles: AlbumRow[] }) {
  const t = useT();
  const membership = useMembership();
  const genres = useGenres();
  const groupBy = useBrowseGroupBy();
  const setGroupBy = useSetBrowseGroupBy();
  const storedKinds = useBrowseKinds();
  const toggleKind = useToggleBrowseKind();
  const focusId = useBrowseFocusId();
  const focusBrowse = useFocusBrowse();
  const reduced = useSyncExternalStore(subscribeReducedMotion, readReducedMotion);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fadeSeq, setFadeSeq] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const player = usePlayerEnabled();
  const organize = useOrganizeEnabled();

  // The chips filter only while both kinds exist; with one kind there is nothing to filter.
  const both = albums.length > 0 && singles.length > 0;
  const kinds = both ? storedKinds : ALL_KINDS;
  const records = useMemo(() => [...albums, ...singles], [albums, singles]);
  const { order, nowYear } = useMemo(() => {
    const now = Date.now() / 1000;
    return {
      order: browseOrder({ albums: records, membership, genres, by: groupBy, kinds, now }),
      nowYear: new Date(now * 1000).getUTCFullYear(),
    };
  }, [records, membership, genres, groupBy, kinds]);

  const count = order.items.length;
  // The index the shelf last rested on: where a removed focus lands instead of snapping to the start.
  const restedAt = useRef<number | null>(null);
  const focus = resolveFocus(order.offsetOf, count, focusId, restedAt.current);
  const focused = count === 0 ? null : order.items[focus];
  useEffect(() => {
    if (count > 0) restedAt.current = focus;
  }, [count, focus]);
  // A focus that fell back to a neighbour becomes the stored one, so later changes follow it.
  useEffect(() => {
    if (focused && focused.id !== focusId) focusBrowse(focused.id);
  }, [focused, focusId, focusBrowse]);
  const actions = useRecordActions(focused);

  // The menu belongs to the focused record alone: a move closes it.
  const focusedId = focused?.id ?? null;
  useEffect(() => setMenuAt(null), [focusedId]);

  const onMenu = useCallback((x: number, y: number) => setMenuAt({ x, y }), []);
  const closeMenu = useCallback(() => {
    setMenuAt(null);
    stageRef.current?.focus({ preventScroll: true });
  }, []);

  const moveTo = useCallback(
    (index: number, jump: boolean) => {
      const target = order.items[index];
      if (!target) return;
      if (index !== focus && (jump || isFarJump(focus, index))) setFadeSeq((n) => n + 1);
      focusBrowse(target.id);
    },
    [order, focus, focusBrowse],
  );

  const onJump = (index: number) => {
    stageRef.current?.focus({ preventScroll: true });
    moveTo(index, true);
  };

  const untitled = t((d) => d.albums.untitled);
  const spoken = focused ? recordLabel(focused, untitled) : "";
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncement(spoken), ANNOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [spoken]);

  let readout = "";
  if (count > 0) {
    const vars = { n: focus + 1, total: count };
    readout =
      order.groups.length > 0
        ? t((d) => d.collection.browseReadoutGroup, {
            ...vars,
            group: groupLabelText(order.groups[order.groupOf[focus]].label, t, nowYear),
          })
        : t((d) => d.collection.browseReadout, vars);
  }

  return (
    <div className={styles.browse}>
      <BrowseToolbar
        kinds={kinds}
        counts={{ albums: albums.length, singles: singles.length }}
        groupBy={groupBy}
        readout={readout}
        onToggleKind={toggleKind}
        onGroupBy={setGroupBy}
      />
      {count === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            tone="idle"
            title={t((d) => d.albums.emptyTitle)}
            line={t((d) => d.albums.emptyLine)}
          />
        </div>
      ) : (
        <div className={styles.body}>
          <BrowseShelf
            order={order}
            focus={focus}
            reduced={reduced}
            fadeSeq={fadeSeq}
            nowYear={nowYear}
            stageRef={stageRef}
            onFocus={moveTo}
            onActivate={actions.activate}
            onMenu={onMenu}
          />
          {focused ? (
            <>
              <BrowseInfo
                album={focused}
                tracks={actions.tracks}
                filed={groupBy === "genre"}
                player={player}
                organize={organize}
                onPlay={actions.play}
                onOpen={actions.open}
                onSelect={actions.select}
              />
              <BrowseTrackList
                key={focused.id}
                tracks={actions.tracks}
                reduced={reduced}
                onPlayFrom={player ? actions.playFrom : undefined}
              />
              <BrowseRecordMenu
                album={focused}
                at={menuAt}
                actions={actions}
                player={player}
                organize={organize}
                onClose={closeMenu}
              />
            </>
          ) : null}
          <BrowseRail order={order} focus={focus} nowYear={nowYear} onJump={onJump} />
        </div>
      )}
      <div className={styles.announcer} aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
