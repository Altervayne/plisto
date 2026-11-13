// -- Component Imports --
import { ScanIssuesSheet } from "./ScanIssuesSheet";

// -- State Imports --
import { useCloseScanIssues, useScanIssuesOpen } from "../../state/scanIssues";

/** Mounts the unreadable-files sheet while the store flag holds it open, whichever entry opened it. */
export function ScanIssuesHost() {
  const open = useScanIssuesOpen();
  const close = useCloseScanIssues();
  return open ? <ScanIssuesSheet onClose={close} /> : null;
}
