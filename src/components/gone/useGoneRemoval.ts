// -- Framework Imports --
import { useState } from "react";

// -- Utils Imports --
import { removeFailureLine, removeGone } from "./goneRemove";

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { PurgeSummary } from "../../types";

/**
 * The remove flow of the gone sheet: the ids waiting on the confirm, whether a purge runs, the receipt of
 * the last one, and the line for a refusal. A refusal leaves the list as it was and shows its line; a
 * success shows the receipt.
 */
export function useGoneRemoval(purge: (ids: number[]) => Promise<PurgeSummary>, t: Translate) {
  const [target, setTarget] = useState<number[] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [receipt, setReceipt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  return {
    target,
    removing,
    receipt,
    error,
    /** Opens the confirm for these ids. */
    request: (ids: number[]) => {
      setError(null);
      setTarget(ids);
    },
    /** Closes the confirm without removing. */
    cancel: () => setTarget(null),
    /** Removes the ids the confirm holds. */
    confirm: async () => {
      if (!target) return;
      setRemoving(true);
      setError(null);
      const outcome = await removeGone(target, purge);
      setRemoving(false);
      if (outcome.kind === "done") setReceipt(outcome.removed);
      else setError(removeFailureLine(t, outcome.reason));
    },
    /** Leaves the receipt for the list. */
    finish: () => setReceipt(null),
  };
}
