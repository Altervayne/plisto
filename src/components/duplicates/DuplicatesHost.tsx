// -- Component Imports --
import { DuplicatesSheet } from "./DuplicatesSheet";

// -- State Imports --
import { useCloseDuplicates, useDuplicatesOpen } from "../../state/shell/store";

/** Mounts the possible-duplicates sheet while the shell flag holds it open, whichever entry opened it. */
export function DuplicatesHost() {
  const open = useDuplicatesOpen();
  const close = useCloseDuplicates();
  return open ? <DuplicatesSheet onClose={close} /> : null;
}
