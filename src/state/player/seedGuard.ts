/*
 * Keeps a slow seed read from overwriting a newer event. A seed asks the engine for a snapshot; an event
 * that lands before the reply is newer than it, so the reply must be dropped.
 */

/** Counts events and hands out per-request checks that fail once an event has arrived since. */
export function createSeedGuard(): { event: () => void; begin: () => () => boolean } {
  let events = 0;
  return {
    event: () => {
      events += 1;
    },
    // The returned check is true while no event has landed since `begin`.
    begin: () => {
      const at = events;
      return () => events === at;
    },
  };
}
