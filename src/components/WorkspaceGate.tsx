// -- Component Imports --
import { AppShell } from "./shell/AppShell";
import { EmptyState } from "./common/EmptyState";
import { QuietButton } from "./common/QuietButton";
import { ScanProgress } from "./scan/ScanProgress";
import { WorkspacePicker } from "./workspace/WorkspacePicker";

// -- State Imports --
import { useRescan, useScanError, useScanStatus, useWorkspace } from "../state/store";

// -- i18n Imports --
import { useT } from "../i18n";

/**
 * The top-level switch. Reads scan and workspace state and picks the view: the picker when there
 * is no workspace, the scanning view mid-scan, an error state on failure, and the app shell
 * once a workspace is indexed.
 */
export function WorkspaceGate() {
  const workspace = useWorkspace();
  const status = useScanStatus();
  const error = useScanError();
  const rescan = useRescan();
  const t = useT();

  if (status === "scanning") return <ScanProgress />;

  if (status === "error") {
    return (
      <EmptyState
        tone="warn"
        title={t((d) => d.scan.failedTitle)}
        line={error ?? t((d) => d.scan.failedLine)}
        action={
          <QuietButton onClick={() => void rescan()}>{t((d) => d.scan.tryAgain)}</QuietButton>
        }
      />
    );
  }

  if (workspace) return <AppShell />;

  return <WorkspacePicker />;
}
