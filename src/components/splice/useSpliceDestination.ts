// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- IPC Imports --
import { destinationPresent, validateExportDestination } from "../../lib/ipc";
import { pickFolder } from "../../lib/dialog";

// -- Type Imports --
import type { DestinationCheck } from "../../types";

/** The destination folder, its validation, and the picker, shared by the splice bodies. */
export interface SpliceDestination {
  destination: string | null;
  check: DestinationCheck | null;
  /** True while a validation call is in flight; a null `check` with this false means it failed. */
  checking: boolean;
  pick: () => Promise<void>;
}

/**
 * The output destination for a splice or crop: the chosen folder plus its export-grade validation.
 * Seeds from the folder a past run remembered, revalidating it; with none remembered it opens with no
 * destination - a neutral prompt to pick, not an in-library warning on the source's own parent. The
 * seed effect guards its result with a per-run alive flag so it survives StrictMode's
 * setup/cleanup/setup. Picking a valid folder remembers it, so the next run opens on it; a pick also
 * supersedes any seed in flight, and a newer pick supersedes an older one.
 */
export function useSpliceDestination(): SpliceDestination {
  const storedDestination = usePreference(PREF_KEYS.spliceDestination);
  const setPreference = useSetPreference();
  const [destination, setDestination] = useState<string | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [checking, setChecking] = useState(false);

  // The newest owner of the destination state: each seed run and each pick takes a number, and only the
  // holder of the current number may apply a result.
  const owner = useRef(0);
  // The last folder a pick validated, so remembering it does not trigger a second validation.
  const pickedPath = useRef<string | null>(null);

  useEffect(() => {
    if (!storedDestination || storedDestination === pickedPath.current) return;
    let alive = true;
    const mine = ++owner.current;
    const live = () => alive && owner.current === mine;
    // The validation creates a missing folder, so a deleted remembered one is dropped before it.
    destinationPresent(storedDestination)
      .then((present) => {
        if (!present) return null;
        if (live()) {
          setDestination(storedDestination);
          setChecking(true);
        }
        return validateExportDestination(storedDestination);
      })
      .then((c) => {
        if (live() && c) setCheck(c);
      })
      .catch(() => {
        if (live()) setCheck(null);
      })
      .finally(() => {
        if (live()) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [storedDestination]);

  const pick = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    const mine = ++owner.current;
    pickedPath.current = picked;
    setDestination(picked);
    setCheck(null);
    setChecking(true);
    try {
      const c = await validateExportDestination(picked);
      if (owner.current !== mine) return;
      setCheck(c);
      if (c.ok) setPreference(PREF_KEYS.spliceDestination, picked);
    } catch {
      if (owner.current === mine) setCheck(null);
    } finally {
      if (owner.current === mine) setChecking(false);
    }
  }, [setPreference]);

  return { destination, check, checking, pick };
}
