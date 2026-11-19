// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { GoneContent, GoneReceipt } from "./GoneContent";
import { GoneRemoveConfirm } from "./GoneRemoveConfirm";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";
import { useWriteGate } from "../organize/useWriteGate";
import { useGoneLocate } from "./useGoneLocate";
import { useGoneRemoval } from "./useGoneRemoval";

// -- State Imports --
import {
  useHoldSync,
  usePurgeGoneTracks,
  useReleaseSync,
  useRescanQuiet,
  useRoots,
} from "../../state/store";
import { useAlbums, useOrganizeStore, useSingles } from "../../state/organize/store";
import { useScanIssuesStore } from "../../state/scanIssues";
import { useGoneScanning } from "../../state/gone/goneEntry";
import { ALL_GONE, GROUP_PAGE } from "../../state/gone/goneGroups";

// -- Utils Imports --
import { buildAlbumIndex, resolveTrackAlbum } from "../tracks/trackAlbum";
import { folderName } from "../settings/locateCopy";
import { GROUP_STEP, TRACK_PAGE, buildView, summaryParts } from "./goneView";
import { escapeTarget, wrapTab } from "./goneFocus";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { GoneResult, GoneScope } from "../../state/gone/goneGroups";
import type { TrackRow } from "../../types";
import type { GoneActions } from "./GoneContent";

// -- Style Imports --
import styles from "./GoneSheet.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;
/** Spaced middle dot between a track's artist and album. */
const META_SEPARATOR = ` ${String.fromCharCode(183)} `;

/**
 * The gone-tracks review, a dimmed modal over the library. It leads with what is probably a moved or
 * offline folder, lists the rest by folder (or flat when few), and removes tracks from the library behind
 * a confirm that notes the restore point. Files are never touched. While a scan runs it shows no counts
 * and every action waits. Portals to the body and closes on Escape, the backdrop, or Close.
 */
export function GoneSheet({
  result,
  scope,
  onOpenScope,
  onShowAll,
  onClose,
}: {
  result: GoneResult;
  scope: GoneScope;
  /** Widens or narrows what the sheet lists. */
  onOpenScope: (scope: GoneScope) => void;
  /** Opens All Tracks with the Gone filter on; the sheet closes with it. */
  onShowAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const scanning = useGoneScanning();
  const gate = useWriteGate("both");
  const purge = usePurgeGoneTracks();
  const rescan = useRescanQuiet();
  const holdSync = useHoldSync();
  const releaseSync = useReleaseSync();
  const roots = useRoots();
  const albums = useAlbums();
  const singles = useSingles();
  const membership = useOrganizeStore((s) => s.org.membership);
  const locate = useGoneLocate();

  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  const removal = useGoneRemoval(
    (ids) =>
      purge(ids).then((summary) => {
        void useScanIssuesStore.getState().refreshStanding();
        return summary;
      }),
    t,
  );
  const { target, removing, receipt, error } = removal;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [shownGroups, setShownGroups] = useState(GROUP_PAGE);
  const [shownTracks, setShownTracks] = useState<Record<string, number>>({});

  // Escape answers the confirm first; the sheet stays until the confirm is gone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeTarget(target != null) === "sheet") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, target]);

  // Focus moves to Close on open and returns to whatever opened the sheet when it goes.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Close is the first button in the panel.
    panelRef.current?.querySelector("button")?.focus();
    return () => opener?.focus();
  }, []);

  // Tab wraps inside the panel. The confirm portals out of it, so only keys from inside the panel count.
  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (event.key !== "Tab" || !panel || !panel.contains(event.target as Node)) return;
    const items = [...panel.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    const at = items.indexOf(event.target as HTMLElement);
    const next = wrapTab(at, items.length, event.shiftKey);
    if (next == null) return;
    event.preventDefault();
    items[next].focus();
  };

  // The confirm names a count, so background sync deltas wait while it is open.
  useEffect(() => {
    if (target == null) return;
    holdSync("purgeConfirm");
    return () => releaseSync("purgeConfirm");
  }, [target, holdSync, releaseSync]);

  const view = useMemo(() => buildView(result), [result]);
  const albumIndex = useMemo(
    () => buildAlbumIndex(membership, [...albums, ...singles]),
    [membership, albums, singles],
  );
  const metaOf = useCallback(
    (track: TrackRow): string => {
      const artist = track.artist_edit ?? track.raw_artist;
      const album = resolveTrackAlbum(track, albumIndex);
      return [artist, album].filter(Boolean).join(META_SEPARATOR) || t((d) => d.gone.noMeta);
    },
    [albumIndex, t],
  );

  const actions: GoneActions = {
    locate: locate.start,
    confirm: locate.confirm,
    retry: locate.recheck,
    dismiss: locate.dismiss,
    rescan: (rootId) => void rescan(rootId),
    remove: removal.request,
    toggle: (id) =>
      setExpanded((all) => {
        const next = new Set(all);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    moreGroups: () => setShownGroups((n) => n + GROUP_STEP),
    moreTracks: (id) => setShownTracks((all) => ({ ...all, [id]: (all[id] ?? TRACK_PAGE) + TRACK_PAGE })),
  };

  if (!card.mounted) return null;

  const title = t((d) => d.gone.title);
  const none = view.total === 0;
  const idle = scanning || none || removing;
  const removeBlocked = gate.blocked || removing;
  const scopeName =
    scope.kind === "album"
      ? ([...albums, ...singles].find((a) => a.id === scope.albumId)?.title ?? null)
      : scope.kind === "root"
        ? folderName(roots.find((r) => r.id === scope.rootId)?.path ?? "")
        : null;
  const parts = summaryParts(view);
  const summary =
    parts.folders == null
      ? t((d) => d.gone.tracks, { n: parts.tracks })
      : t((d) => d.gone.summary, {
          tracks: t((d) => d.gone.tracks, { n: parts.tracks }),
          folders: t((d) => d.gone.folders, { n: parts.folders }),
        });

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onPanelKey}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.sub}>{t((d) => d.gone.sub)}</p>
            {scanning || none || receipt != null ? null : <p className={styles.summary}>{summary}</p>}
          </div>
          <QuietButton onClick={requestClose}>{t((d) => d.common.close)}</QuietButton>
        </div>

        {scope.kind !== "all" && scopeName ? (
          <div className={styles.scope}>
            <span>{t((d) => d.gone.scope, { name: scopeName })}</span>
            <button type="button" className={styles.textLink} onClick={() => onOpenScope(ALL_GONE)}>
              {t((d) => d.gone.scopeAll)}
            </button>
          </div>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <ScrollArea className={styles.list} contentClassName={styles.body}>
          {receipt != null ? (
            <GoneReceipt removed={receipt} />
          ) : (
            <GoneContent
              view={view}
              scanning={scanning}
              removeBlocked={removeBlocked}
              removeTip={gate.tip}
              steps={locate.steps}
              expanded={expanded}
              shownGroups={shownGroups}
              shownTracks={shownTracks}
              metaOf={metaOf}
              actions={actions}
            />
          )}
        </ScrollArea>

        <div className={styles.foot}>
          <span className={styles.safety}>{t((d) => d.gone.safety)}</span>
          {receipt != null ? (
            <PrimaryButton onClick={removal.finish}>{t((d) => d.gone.done)}</PrimaryButton>
          ) : (
            <>
              <QuietButton
                onClick={() => {
                  requestClose();
                  onShowAll();
                }}
                disabled={idle}
              >
                {t((d) => d.gone.showAll)}
              </QuietButton>
              <Tooltip label={gate.tip}>
                <QuietButton
                  destructive
                  onClick={() => actions.remove(result.ids)}
                  disabled={idle || gate.blocked}
                >
                  {scope.kind === "all" ? t((d) => d.gone.removeAll) : t((d) => d.gone.removeThese)}
                </QuietButton>
              </Tooltip>
            </>
          )}
        </div>

        <GoneRemoveConfirm
          count={target?.length ?? null}
          onConfirm={() => void removal.confirm()}
          onClose={removal.cancel}
        />
      </div>
    </div>,
    document.body,
  );
}
