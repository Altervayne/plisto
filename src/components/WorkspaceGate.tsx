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

/**
 * The top-level switch. Boots once on mount by hydrating the roots (and the last index when any
 * exist), then picks the view: nothing until booted, the scanning view mid-scan, an error state on
 * failure, the app shell over a stocked library, and onboarding when the library is empty.
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

  if (status === "scanning") return <ScanProgress />;

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

  if (roots.length > 0) return <AppShell />;

  return <WorkspacePicker />;
}
