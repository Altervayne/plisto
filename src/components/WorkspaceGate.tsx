// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { AppShell } from "./shell/AppShell";
import { BootStalled } from "./BootStalled";
import { EmptyState } from "./common/EmptyState";
import { PendingSpinner } from "./common/PendingSpinner";
import { QuietButton } from "./common/QuietButton";
import { ScanProgress } from "./scan/ScanProgress";
import { RelinkPrompt } from "./settings/RelinkPrompt";
import { WorkspacePicker } from "./workspace/WorkspacePicker";

// -- State Imports --
import {
  useBoot,
  useBootStalled,
  useBooted,
  useRescanAll,
  useRoots,
  useScanError,
  useScanMode,
  useScanStatus,
} from "../state/store";

// -- i18n Imports --
import { useT } from "../i18n";

// -- Style Imports --
import styles from "./WorkspaceGate.module.css";

/**
 * The top-level switch. Boots once on mount by hydrating the roots (and the last index when any
 * exist), then picks the view: a quiet wait until booted (a stalled-start state with a retry once the
 * read is overdue), an error state on failure, the app shell over a stocked library, and onboarding when
 * the library is empty. A blocking scan overlays the shell rather than replacing it, so it keeps the
 * shell mounted and returns the user to the view they were on. The relink prompt, for a picked folder
 * that looks like a moved root, mounts beside the shell. A quiet scan never reaches this switch: its
 * progress and failure live in the title bar and Settings.
 */
export function WorkspaceGate() {
  const boot = useBoot();
  const booted = useBooted();
  const stalled = useBootStalled();
  const roots = useRoots();
  const status = useScanStatus();
  const blocking = useScanMode() === "blocking";
  const error = useScanError();
  const rescanAll = useRescanAll();
  const t = useT();

  useEffect(() => {
    void boot();
  }, [boot]);

  // Hold the picker back until the roots hydrate, so it never flashes before the library opens. A slow
  // read shows a spinner; one stuck past the stall threshold says so, with a retry.
  if (!booted) {
    return stalled ? (
      <BootStalled />
    ) : (
      <PendingSpinner title={t((d) => d.projections.bootLoadingTitle)} />
    );
  }

  if (status === "error" && blocking) {
    return (
      <EmptyState
        tone="warn"
        title={t((d) => d.scan.failedTitle)}
        line={error ?? t((d) => d.scan.failedLine)}
        action={
          <QuietButton onClick={() => void rescanAll()}>{t((d) => d.scan.tryAgain)}</QuietButton>
        }
      />
    );
  }

  // A stocked workspace keeps its shell mounted; a running scan lays over it rather than replacing it, so
  // a rescan never unmounts the shell and returns the user to the view they were on. Before a workspace
  // exists there is no shell to preserve, so the scan owns the screen.
  if (roots.length > 0) {
    return (
      <>
        <AppShell />
        <RelinkPrompt />
        {status === "scanning" && blocking ? (
          <div className={styles.scanOverlay}>
            <ScanProgress />
          </div>
        ) : null}
      </>
    );
  }

  if (status === "scanning" && blocking) return <ScanProgress />;

  return <WorkspacePicker />;
}
