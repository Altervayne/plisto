// -- Component Imports --
import { BusyToast } from "./BusyToast";
import { KeptBackupsSheet } from "./KeptBackupsSheet";
import { RecoveryToast } from "./RecoveryToast";
import { StampSheet } from "./StampSheet";

// -- Hook Imports --
import { useWriteRecovery } from "./useWriteRecovery";

// -- State Imports --
import { useCloseFileWritesSheet, useFileWritesSheet } from "../../state/fileWrites/store";

/**
 * Mounts the sheet the file-writes store holds open, whichever entry opened it, and the notice about
 * writes settled after an interrupted run. Mounted once in the shell so both reach any screen.
 */
export function FileWritesHost() {
  const sheet = useFileWritesSheet();
  const close = useCloseFileWritesSheet();
  useWriteRecovery();

  return (
    <>
      {sheet?.kind === "stamp" ? <StampSheet scope={sheet.scope} onClose={close} /> : null}
      {sheet?.kind === "stampUndo" ? <StampSheet scope={null} undoBatchId={sheet.batchId} onClose={close} /> : null}
      {sheet?.kind === "kept" ? <KeptBackupsSheet onClose={close} /> : null}
      <RecoveryToast />
      <BusyToast />
    </>
  );
}
