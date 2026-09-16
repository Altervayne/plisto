// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { AppShell } from "./shell/AppShell";
import { EmptyState } from "./common/EmptyState";
import { QuietButton } from "./common/QuietButton";
import { ScanProgress } from "./scan/ScanProgress";
import { WorkspacePicker } from "./workspace/WorkspacePicker";

// -- State Imports --
import { useBoot, useBooted, useRescanAll, useRoots, useScanError, useScanStatus } from "../state/store";

// -- i18n Imports --
import { useT } from "../i18n";

// -- Style Imports --
import styles from "./WorkspaceGate.module.css";

/**
 * The top-level switch. Boots once on mount by hydrating the roots (and the last index when any
 * exist), then picks the view: nothing until booted, an error state on failure, the app shell over a
 * stocked library, and onboarding when the library is empty. A scan overlays the shell rather than
 * replacing it, so a rescan keeps the shell mounted and returns the user to the view they were on.
 */
export function WorkspaceGate() {
  const boot = useBoot();
  const booted = useBooted();
  const roots = useRoots();
  const status = useScanStatus();
  const error = useScanError();
  const rescanAll = useRescanAll();
  const t = useT();

  useEffect(() => {
    void boot();
  }, [boot]);

  // Hold nothing until the roots hydrate, so the picker never flashes before the library opens.
  if (!booted) return null;

  if (status === "error") {
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
        {status === "scanning" ? (
          <div className={styles.scanOverlay}>
            <ScanProgress />
          </div>
        ) : null}
      </>
    );
  }

  if (status === "scanning") return <ScanProgress />;

  return <WorkspacePicker />;
}
