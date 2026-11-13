/*
 * The hub's operation lock as a hook: one lock for the life of the section, with `busy` as state so
 * controls that would be refused can disable themselves.
 */

// -- Framework Imports --
import { useMemo, useSyncExternalStore } from "react";

// -- State Imports --
import { createLock } from "../../../state/plugins/operationLock";

// -- Type Imports --
import type { OperationLock } from "../../../state/plugins/operationLock";

export function useOperationLock(): OperationLock {
  const lock = useMemo(createLock, []);
  useSyncExternalStore(lock.subscribe, () => lock.busy);
  return lock;
}
