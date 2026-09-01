// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- IPC Imports --
import { validateExportDestination } from "../../lib/ipc";
import { pickFolder } from "../../lib/dialog";

// -- Type Imports --
import type { DestinationCheck } from "../../types";

/** The destination folder, its validation, and the picker, shared by the splice bodies. */
export interface SpliceDestination {
  destination: string | null;
  check: DestinationCheck | null;
  pick: () => Promise<void>;
}

/**
 * The output destination for a splice or crop: the chosen folder plus its export-grade validation.
 * Seeds from the folder a past run remembered, revalidating it; with none remembered it opens with no
 * destination - a neutral prompt to pick, not an in-library warning on the source's own parent. The
 * seed effect guards its result with a per-run alive flag, no ref, so it survives StrictMode's
 * setup/cleanup/setup. Picking a valid folder remembers it, so the next run opens on it.
 */
export function useSpliceDestination(): SpliceDestination {
  const storedDestination = usePreference(PREF_KEYS.spliceDestination);
  const setPreference = useSetPreference();
  const [destination, setDestination] = useState<string | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);

  useEffect(() => {
    if (!storedDestination) return;
    let alive = true;
    setDestination(storedDestination);
    validateExportDestination(storedDestination)
      .then((c) => {
        if (alive) setCheck(c);
      })
      .catch(() => {
        if (alive) setCheck(null);
      });
    return () => {
      alive = false;
    };
  }, [storedDestination]);

  const pick = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setDestination(picked);
    try {
      const c = await validateExportDestination(picked);
      setCheck(c);
      if (c.ok) setPreference(PREF_KEYS.spliceDestination, picked);
    } catch {
      setCheck(null);
    }
  }, [setPreference]);

  return { destination, check, pick };
}
