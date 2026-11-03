// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { useOfflineRoots, useRoots } from "../../state/store";
import { locateEligible } from "../../state/relocate";

// -- IPC Imports --
import { previewRelocate } from "../../lib/ipc";

// -- Type Imports --
import type { Root } from "../../types";

/**
 * The folder an eligible root already seems to live in: the first other root that is itself present and
 * whose indexed tracks the backend would merge onto this one. The preview is a database-only check, so
 * it is cheap to run for each candidate. Null when the root is not eligible or nothing matches, and
 * after any failure.
 */
export function useMergeHint(root: Root): string | null {
  const roots = useRoots();
  const offline = useOfflineRoots();
  const eligible = locateEligible(root, offline);
  const [hint, setHint] = useState<string | null>(null);

  // One string stands for the candidate set, so a fresh roots array with the same folders never reruns the check.
  const candidates = roots.filter((r) => r.id !== root.id && !locateEligible(r, offline));
  const key = candidates.map((r) => `${r.id}:${r.path}`).join("|");

  useEffect(() => {
    if (!eligible) {
      setHint(null);
      return;
    }
    let live = true;
    void (async () => {
      for (const other of candidates) {
        try {
          const preview = await previewRelocate(root.id, other.path);
          if (!live) return;
          if (preview.kind === "merge") {
            setHint(other.path);
            return;
          }
        } catch {
          // A failed check reads as no match.
        }
      }
      if (live) setHint(null);
    })();
    return () => {
      live = false;
    };
  }, [eligible, root.id, key]);

  return eligible ? hint : null;
}
