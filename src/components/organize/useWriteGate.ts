// -- State Imports --
import { useOrgStatus, usePlaylistsStatus } from "../../state/projectionStatus";

// -- i18n Imports --
import { useT } from "../../i18n";

/** Which loaded projection a control's write acts on. */
export type WriteScope = "albums" | "playlists" | "both";

export interface WriteGate {
  /** True while the projection the write needs has not loaded, so the control must be disabled. */
  blocked: boolean;
  /** The tooltip a disabled control carries; undefined once the write can go ahead. */
  tip: string | undefined;
}

/**
 * Whether a control's write may run yet. Mirrors the store's own gate, which refuses the same write: the
 * control disables with a tooltip first, and the store is the net behind it.
 */
export function useWriteGate(scope: WriteScope): WriteGate {
  const org = useOrgStatus();
  const playlists = usePlaylistsStatus();
  const t = useT();
  const blocked =
    (scope !== "playlists" && org !== "ready") || (scope !== "albums" && playlists !== "ready");
  return { blocked, tip: blocked ? t((d) => d.projections.writeBlocked) : undefined };
}
