// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- IPC Imports --
import { exportChanges } from "../../lib/ipc";

// -- Type Imports --
import type { ExportChangeSet, ExportConfig } from "../../types";

// Quiet time after the last config change before the preview is asked for, so a burst of toggles
// reads the destination once.
const DEBOUNCE_MS = 250;

/**
 * The changed-only preview of `config`, or null while none is in hand. A null config asks nothing.
 * Each answer is tied to the config it was asked for, so a stale reply never shows against a newer
 * config; `refresh` asks again for the same config, keeping the current answer until the new one lands.
 * A failed preview reads as none, leaving the run to compute its own diff.
 */
export function useExportChanges(config: ExportConfig | null): {
  changes: ExportChangeSet | null;
  refresh: () => void;
} {
  const key = config ? JSON.stringify(config) : null;
  const [nonce, setNonce] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; changes: ExportChangeSet | null } | null>(
    null,
  );
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    if (key === null) return;
    const timer = setTimeout(() => {
      exportChanges(JSON.parse(key) as ExportConfig).then(
        (changes) => {
          if (request === latest.current) setAnswer({ key, changes });
        },
        () => {
          if (request === latest.current) setAnswer({ key, changes: null });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const changes = answer && answer.key === key ? answer.changes : null;
  return { changes, refresh };
}
