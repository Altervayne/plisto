// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { GoneSheet } from "./GoneSheet";

// -- State Imports --
import { useGoneSummary } from "../../state/gone/goneEntry";
import { useCloseGone, useGoneOpen, useGoneScope, useOpenGone } from "../../state/shell/store";

/**
 * Mounts the gone-tracks sheet while the shell flag holds it open, whichever entry opened it. The sheet
 * needs the grouping, which waits for the organization; an open flag that finds none closes itself rather
 * than surfacing the sheet later, on its own.
 */
export function GoneHost({ onShowAll }: { onShowAll: () => void }) {
  const open = useGoneOpen();
  const scope = useGoneScope();
  const close = useCloseGone();
  const openScope = useOpenGone();
  const summary = useGoneSummary();

  useEffect(() => {
    if (open && !summary) close();
  }, [open, summary, close]);

  if (!open || !summary) return null;
  return (
    <GoneSheet result={summary} scope={scope} onOpenScope={openScope} onShowAll={onShowAll} onClose={close} />
  );
}
