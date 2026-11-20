// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { GoneBlock } from "./GoneBlock";
import { GoneGroupRow, GoneTrackRow } from "./GoneGroupRow";
import { GoneStaffs } from "./GoneStaffs";

// -- State Imports --
import { pageGroups } from "../../state/gone/goneGroups";

// -- Utils Imports --
import { folderName } from "../settings/locateCopy";
import { GROUP_STEP, TRACK_PAGE, idsOf, isSubfolder } from "./goneView";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { GoneGroup } from "../../state/gone/goneGroups";
import type { LocateStep } from "../settings/locateFlow";
import type { Root, TrackRow } from "../../types";
import type { GoneView } from "./goneView";

// -- Style Imports --
import styles from "./GoneContent.module.css";

/** What the sheet's rows can do; the sheet owns the state behind each. */
export interface GoneActions {
  locate: (rootId: number, name: string) => void;
  confirm: (rootId: number) => void;
  retry: (rootId: number) => void;
  dismiss: (rootId: number) => void;
  /** The folder flow behind a subfolder's Locate, keyed by the group's folded id. */
  folder: {
    start: (group: GoneGroup) => void;
    confirm: (id: string) => void;
    retry: (id: string) => void;
    dismiss: (id: string) => void;
    stop: (id: string) => void;
  };
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
 * after the root stops being gone, so a finished Locate reads as done rather than vanishing; a folder's
 * step does the same once a locate empties its group.
 */
export function GoneContent({
  view,
  scanning,
  removeBlocked,
  removeTip,
  steps,
  folderSteps,
  folderBusy,
  roots,
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
  /** The Locate step of each gone folder that has one, by the group's folded id. */
  folderSteps: Record<string, LocateStep>;
  /** A folder apply holds the scan lock, so every Locate and Remove waits. */
  folderBusy: boolean;
  roots: Root[];
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
  const locked = scanning || folderBusy;
  // A folder step shows as a notice once its group has left the list, or while a scan hides every row.
  const listedFolders = new Set([...view.likely, ...view.groups].map((g) => g.id));
  const folderNotices = Object.entries(folderSteps)
    .filter(([id, step]) => step.kind !== "idle" && (scanning || !listedFolders.has(id)))
    .map(([id, step]) => (
      <GoneBlock
        key={`fstep:${id}`}
        kind="moved"
        path=""
        count={0}
        step={step}
        locked={locked}
        removeBlocked
        onConfirm={() => actions.folder.confirm(id)}
        onRetry={() => actions.folder.retry(id)}
        onDismiss={() => actions.folder.dismiss(id)}
        onStop={() => actions.folder.stop(id)}
      />
    ));
  const notices = leftover.map(({ id, step }) => (
    <GoneBlock
      key={`step:${id}`}
      kind={offlineIds.has(id) ? "offline" : "moved"}
      path=""
      count={0}
      step={step}
      locked={locked}
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
        {folderNotices}
        <div className={styles.center}>
          <GoneStaffs tall />
          <p className={styles.centerTitle}>{t((d) => d.gone.scanTitle)}</p>
          <small className={styles.centerLine}>{t((d) => d.gone.scanLine)}</small>
        </div>
      </>
    );
  }

  const { visible, hiddenFolders } = pageGroups(view.groups, shownGroups);
  const removal = { removeBlocked: removeBlocked || folderBusy, removeTip };
  const folderStepOf = (id: string): LocateStep => folderSteps[id] ?? { kind: "idle" };

  return (
    <>
      {notices}
      {folderNotices}
      {view.offline.map(({ root }) => (
        <GoneBlock
          key={`offline:${root.id}`}
          kind="offline"
          path={root.path}
          count={root.track_count}
          step={stepOf(root.id)}
          locked={locked}
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
          locked={locked}
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
          step={folderStepOf(group.id)}
          locked={locked}
          {...removal}
          onLocate={group.rootId != null ? () => actions.folder.start(group) : undefined}
          onRemove={() => actions.remove(idsOf(group.tracks))}
          onConfirm={() => actions.folder.confirm(group.id)}
          onRetry={() => actions.folder.retry(group.id)}
          onDismiss={() => actions.folder.dismiss(group.id)}
          onStop={() => actions.folder.stop(group.id)}
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
              locked={locked}
              {...removal}
              metaOf={metaOf}
              locate={
                group.rootId != null && isSubfolder(group, roots)
                  ? {
                      step: folderStepOf(group.id),
                      onStart: () => actions.folder.start(group),
                      onConfirm: () => actions.folder.confirm(group.id),
                      onRetry: () => actions.folder.retry(group.id),
                      onDismiss: () => actions.folder.dismiss(group.id),
                      onStop: () => actions.folder.stop(group.id),
                    }
                  : undefined
              }
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
