// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { StaffSpinner } from "../scan/StaffSpinner";
import { CoverFilter } from "./CoverFilter";
import { CoverMatchPreview } from "./CoverMatchPreview";
import { FolderCoverRow } from "./FolderCoverRow";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";
import { tracksInFolder } from "./useFolderTracks";

// -- Unit Imports --
import { matchStemPairs } from "./matchCovers";

// -- State Imports --
import { useTracks } from "../../state/store";
import {
  useCancelCovers,
  useCoverGroups,
  useCoversStatus,
  useDiscoverCovers,
} from "../../state/covers/store";

// -- Type Imports --
import type { CoverScope } from "./CoverFilter";
import type { CoverMatch } from "./matchCovers";
import type { ImageFolderGroup } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CoversView.module.css";

/** A covered row's fade before it leaves the Needs-cover list, matching --dur-soft on the exit keyframe. */
const ROW_EXIT_MS = 200;

/** Whether a group belongs in the current scope: every discovered folder, or only those still bare. */
function inScope(group: ImageFolderGroup, scope: CoverScope): boolean {
  return scope === "all" ? true : group.needs_cover;
}

/**
 * The covers workspace: a full-region triage of every folder holding loose images, wired to the streamed
 * discovery sweep. It runs the sweep on entry and cancels it on leave; a manual refresh re-reads. The
 * Needs cover / All toggle scopes the wall, which lands needs-first so the backlog sits up top. A folder
 * covered here fades out of the Needs view at once. While a scan holds the same folders the sweep is
 * refused, surfaced as a quiet paused state. Covers binds art that already sits in the library; it never
 * moves, renames, or deletes a file.
 */
export function CoversView() {
  const groups = useCoverGroups();
  const status = useCoversStatus();
  const discover = useDiscoverCovers();
  const cancel = useCancelCovers();
  const tracks = useTracks();
  const t = useT();
  const [scope, setScope] = useState<CoverScope>("needs");
  // The library-wide filename matches under review, or null when the preview is closed.
  const [preview, setPreview] = useState<CoverMatch[] | null>(null);
  // How many covers the last apply landed, shown briefly then cleared.
  const [matched, setMatched] = useState<number | null>(null);

  // Run the sweep on entering the workspace, stop it on leaving. Both actions are stable store refs.
  useEffect(() => {
    void discover();
    return () => {
      void cancel();
    };
  }, [discover, cancel]);

  // The applied notice fades on its own after a moment; a fresh apply restarts the timer.
  useEffect(() => {
    if (matched == null) return;
    const id = window.setTimeout(() => setMatched(null), 4000);
    return () => window.clearTimeout(id);
  }, [matched]);

  // Every filename pair across every discovered folder, gathered on demand for the library-wide preview.
  const openLibraryMatch = () => {
    setPreview(
      groups.flatMap((g) => matchStemPairs(g.images, tracksInFolder(tracks, g.folder_path))),
    );
  };

  // Needs-cover first, then by folder name, so the backlog leads regardless of the walk order.
  const ordered = useMemo(() => {
    return [...groups].sort((a, b) => {
      if (a.needs_cover !== b.needs_cover) return a.needs_cover ? -1 : 1;
      return a.folder_name.localeCompare(b.folder_name, undefined, { sensitivity: "base" });
    });
  }, [groups]);

  const inScopeCount = ordered.reduce((n, g) => (inScope(g, scope) ? n + 1 : n), 0);

  if (status === "blocked") {
    return (
      <EmptyState
        tone="warn"
        title={t((d) => d.covers.blockedTitle)}
        line={t((d) => d.covers.blockedLine)}
        action={<QuietButton onClick={() => void discover()}>{t((d) => d.covers.refresh)}</QuietButton>}
      />
    );
  }

  if (status === "reading" && groups.length === 0) {
    return (
      <CenteredStage>
        <div className={styles.reading}>
          <StaffSpinner />
          <h1 className={styles.readingTitle}>{t((d) => d.covers.readingTitle)}</h1>
          <p className={styles.readingLine}>{t((d) => d.covers.readingLine)}</p>
        </div>
      </CenteredStage>
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <CoverFilter value={scope} onChange={setScope} />
        <div className={styles.actions}>
          {status === "reading" ? (
            <span className={styles.readingHint}>{t((d) => d.covers.readingTitle)}</span>
          ) : null}
          {matched != null ? (
            <span className={styles.readingHint}>
              {t((d) => d.covers.matchedNotice, { n: matched })}
            </span>
          ) : null}
          <QuietButton onClick={openLibraryMatch} disabled={status === "reading"}>
            {t((d) => d.covers.autoMatch)}
          </QuietButton>
          <QuietButton onClick={() => void discover()} disabled={status === "reading"}>
            {t((d) => d.covers.refresh)}
          </QuietButton>
        </div>
      </div>

      <p className={styles.safety}>{t((d) => d.covers.safety)}</p>

      {inScopeCount === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            tone={scope === "needs" ? "good" : "idle"}
            title={
              scope === "needs"
                ? t((d) => d.covers.emptyNeedsTitle)
                : t((d) => d.covers.emptyAllTitle)
            }
            line={
              scope === "needs"
                ? t((d) => d.covers.emptyNeedsLine)
                : t((d) => d.covers.emptyAllLine)
            }
          />
        </div>
      ) : (
        <ScrollArea className={styles.scroll} contentClassName={styles.canvas}>
          <div className={styles.wall}>
            {ordered.map((group) => (
              <CoverRowSlot key={group.folder_path} group={group} present={inScope(group, scope)} />
            ))}
          </div>
        </ScrollArea>
      )}

      {preview != null ? (
        <CoverMatchPreview
          matches={preview}
          onClose={() => setPreview(null)}
          onApplied={(count) => {
            setPreview(null);
            setMatched(count);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One row's presence in the wall. It holds the row mounted through its fade when the folder leaves the
 * current scope (covered under Needs cover), then drops it. A folder that starts out of scope never
 * mounts its row at all.
 */
function CoverRowSlot({ group, present }: { group: ImageFolderGroup; present: boolean }) {
  const slot = useMountTransition(present, ROW_EXIT_MS);
  if (!slot.mounted) return null;
  return (
    <div className={styles.slot} data-state={slot.state}>
      <FolderCoverRow group={group} />
    </div>
  );
}
