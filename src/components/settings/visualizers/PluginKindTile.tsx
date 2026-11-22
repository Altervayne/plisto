// -- Framework Imports --
import { useState, useSyncExternalStore } from "react";

// -- Component Imports --
import { CatalogTile } from "./CatalogTile";

// -- State Imports --
import { stageHandles, watchStages } from "../../../state/player/pluginVis/frameCache";
import { markOf, markStops, reloadVisMarks, useNetPolicy } from "../../../state/player/pluginVis/netPolicy";
import { selectStopFlashing, usePreferencesStore } from "../../../state/preferences/store";

// -- IPC Imports --
import { pluginVisClearMark } from "../../../lib/ipc";

// -- Type Imports --
import type { CatalogRow } from "./useCatalogRows";

/** Why Plisto stops a kind now, or null: a reset always, flashing only under the setting. */
function useStopCause(kind: string): "flash" | "reset" | null {
  const stopFlashing = usePreferencesStore(selectStopFlashing);
  return useNetPolicy((s) => {
    const mark = markOf(s, kind);
    if (!markStops(mark, stopFlashing)) return null;
    return mark?.graphics_reset ? "reset" : "flash";
  });
}

/** Whether a mounted frame of the kind reports no canvas for the flash meter; only read under the setting. */
function useUnwatched(kind: string): boolean {
  const stopFlashing = usePreferencesStore(selectStopFlashing);
  const unmetered = useSyncExternalStore(
    watchStages,
    () => stageHandles().some((h) => h.kind === kind && h.metered() === false),
    () => false,
  );
  return stopFlashing && unmetered;
}

/**
 * Clears a kind's fault marks, drops any mark written here that a failed write kept for the session (a
 * read would not remove it), then reads the marks again so the tile and the stage both see it. Resolves
 * false when the clear was refused.
 */
export function turnBackOn(kind: string): Promise<boolean> {
  const slash = kind.indexOf("/");
  return pluginVisClearMark(kind.slice(0, slash), kind.slice(slash + 1)).then(
    () => {
      useNetPolicy.setState((s) => {
        const { [kind]: _dropped, ...pending } = s.pending;
        return { pending };
      });
      reloadVisMarks();
      return true;
    },
    (e: unknown) => {
      console.warn("turning a visualizer back on failed", e);
      return false;
    },
  );
}

/** A plugin kind's tile with the marks the stage keeps for it. */
export function PluginKindTile({
  row,
  on,
  dimmed,
  disabled,
  onChange,
}: {
  row: CatalogRow;
  on: boolean;
  dimmed: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const cause = useStopCause(row.id);
  const unwatched = useUnwatched(row.id);
  const [failed, setFailed] = useState(false);
  const turnBack = () => {
    setFailed(false);
    void turnBackOn(row.id).then((ok) => setFailed(!ok));
  };
  return (
    <CatalogTile
      row={row}
      on={on}
      dimmed={dimmed}
      disabled={disabled}
      onChange={onChange}
      stop={cause ? { cause, onTurnBack: turnBack } : null}
      turnBackFailed={failed}
      unwatched={cause === null && unwatched}
    />
  );
}
