// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { GoneBlock } from "./GoneBlock";
import { GoneGroupRow, GoneTrackRow } from "./GoneGroupRow";
import { GoneStaffs } from "./GoneStaffs";

// -- State Imports --
import { pageGroups } from "../../state/gone/goneGroups";

// -- Utils Imports --
import { folderName } from "../settings/locateCopy";
import { GROUP_STEP, TRACK_PAGE, idsOf } from "./goneView";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { LocateStep } from "../settings/locateFlow";
import type { TrackRow } from "../../types";
import type { GoneView } from "./goneView";

// -- Style Imports --
import styles from "./GoneContent.module.css";

/** What the sheet's rows can do; the sheet owns the state behind each. */
export interface GoneActions {
  locate: (rootId: number, name: string) => void;
  confirm: (rootId: number) => void;
  retry: (rootId: number) => void;
  dismiss: (rootId: number) => void;
  rescan: (rootId: number) => void;
  remove: (ids: number[]) => void;
  toggle: (groupId: string) => void;
  moreGroups: () => void;
  moreTracks: (groupId: string) => void;
}

/** The state after a remove: how many tracks left the library, and that the files stayed put. */
export function GoneReceipt({ removed }: { removed: number }) {
  const t = useT();
  return (
    <div className={styles.center} role="status">
      <span className={styles.tone} />
      <p className={styles.centerTitle}>{t((d) => d.gone.receipt, { n: removed })}</p>
      <small className={styles.centerLine}>{t((d) => d.gone.receiptSub)}</small>
    </div>
  );
}

/**
 * The sheet's body below the header: the offline and moved notices, the folders and the flat list, or the
 * scan state while a scan runs. A Locate step that is still on screen keeps its notice through a scan and
 * after the root stops being gone, so a finished Locate reads as done rather than vanishing.
 */
export function GoneContent({
  view,
  scanning,
  removeBlocked,
  removeTip,
  steps,
  expanded,
  shownGroups,
  shownTracks,
  metaOf,
  actions,
}: {
  view: GoneView;
  scanning: boolean;
  removeBlocked: boolean;
  removeTip?: string;
  /** The Locate step of each root that has one. */
  steps: Record<number, LocateStep>;
  expanded: ReadonlySet<string>;
  shownGroups: number;
  /** Tracks listed per open folder, by folder id; absent means one page. */
  shownTracks: Record<string, number>;
  metaOf: (track: TrackRow) => string;
  actions: GoneActions;
}) {
  const t = useT();
  const stepOf = (id: number): LocateStep => steps[id] ?? { kind: "idle" };
  const listed = new Set([...view.offline.map((o) => o.root.id), ...view.moved.map((m) => m.root.id)]);
  const offlineIds = new Set(view.offline.map((o) => o.root.id));
  const active = Object.entries(steps)
    .map(([id, step]) => ({ id: Number(id), step }))
    .filter(({ step }) => step.kind !== "idle");
  // A finished or refused Locate on a root that is no longer listed keeps its notice. During a scan every
  // running step stays, listed or not, since the relocate itself is what the scan is.
  const leftover = scanning ? active : active.filter(({ id }) => !listed.has(id));
  const notices = leftover.map(({ id, step }) => (
    <GoneBlock
      key={`step:${id}`}
      kind={offlineIds.has(id) ? "offline" : "moved"}
      path=""
      count={0}
      step={step}
      locked={scanning}
      removeBlocked
      onConfirm={() => actions.confirm(id)}
      onRetry={() => actions.retry(id)}
      onDismiss={() => actions.dismiss(id)}
    />
  ));

  if (scanning) {
    return (
      <>
        {notices}
        <div className={styles.center}>
          <GoneStaffs tall />
          <p className={styles.centerTitle}>{t((d) => d.gone.scanTitle)}</p>
          <small className={styles.centerLine}>{t((d) => d.gone.scanLine)}</small>
        </div>
      </>
    );
  }

  const { visible, hiddenFolders } = pageGroups(view.groups, shownGroups);
  const removal = { removeBlocked, removeTip };

  return (
    <>
      {notices}
      {view.offline.map(({ root }) => (
        <GoneBlock
          key={`offline:${root.id}`}
          kind="offline"
          path={root.path}
          count={root.track_count}
          step={stepOf(root.id)}
          locked={scanning}
          removeBlocked
          onLocate={() => actions.locate(root.id, folderName(root.path))}
          onRescan={() => actions.rescan(root.id)}
          onConfirm={() => actions.confirm(root.id)}
          onRetry={() => actions.retry(root.id)}
          onDismiss={() => actions.dismiss(root.id)}
        />
      ))}
      {view.moved.map(({ root, tracks }) => (
        <GoneBlock
          key={`moved:${root.id}`}
          kind="moved"
          path={root.path}
          count={tracks.length}
          step={stepOf(root.id)}
          locked={scanning}
          {...removal}
          onLocate={() => actions.locate(root.id, folderName(root.path))}
          onRemove={() => actions.remove(idsOf(tracks))}
          onConfirm={() => actions.confirm(root.id)}
          onRetry={() => actions.retry(root.id)}
          onDismiss={() => actions.dismiss(root.id)}
        />
      ))}
      {view.likely.map((group) => (
        <GoneBlock
          key={`likely:${group.id}`}
          kind="moved"
          path={group.path}
          count={group.tracks.length}
          step={{ kind: "idle" }}
          locked={scanning}
          {...removal}
          onRemove={() => actions.remove(idsOf(group.tracks))}
          onConfirm={() => undefined}
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />
      ))}
      {view.groups.length > 0 ? (
        <>
          <div className={styles.label}>{t((d) => d.gone.groupsLabel)}</div>
          {visible.map((group) => (
            <GoneGroupRow
              key={group.id}
              group={group}
              open={expanded.has(group.id)}
              shownTracks={shownTracks[group.id] ?? TRACK_PAGE}
              locked={scanning}
              {...removal}
              metaOf={metaOf}
              onToggle={() => actions.toggle(group.id)}
              onMoreTracks={() => actions.moreTracks(group.id)}
              onRemove={() => actions.remove(idsOf(group.tracks))}
            />
          ))}
          {hiddenFolders > 0 ? (
            <div className={styles.more}>
              <QuietButton onClick={actions.moreGroups}>
                {t((d) => d.gone.moreFolders, { n: Math.min(hiddenFolders, GROUP_STEP) })}
              </QuietButton>
            </div>
          ) : null}
        </>
      ) : null}
      {view.flat?.map((track) => <GoneTrackRow key={track.id} track={track} meta={metaOf(track)} flat />)}
      {view.total === 0 ? (
        <div className={styles.center}>
          <span className={styles.tone} />
          <p className={styles.centerTitle}>{t((d) => d.gone.noneTitle)}</p>
          <small className={styles.centerLine}>{t((d) => d.gone.noneLine)}</small>
        </div>
      ) : null}
    </>
  );
}
