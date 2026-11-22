/*
 * A signal that a plugin's installed build was replaced (a developer reload or an update), so what was
 * made under the old build can be checked again.
 */

type Listener = (pluginId: string) => void;

const listeners = new Set<Listener>();

/** Says that `pluginId` now has a different build installed. A listener that throws stops no other. */
export function notifyBuildReplaced(pluginId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(pluginId);
    } catch (e) {
      console.error("a build-replaced listener failed", e);
    }
  }
}

/** Calls `listener` on each replaced build until the returned release runs. */
export function onBuildReplaced(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
