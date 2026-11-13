/*
 * One plugin operation at a time. Every command the hub starts runs through `run`: a second start while
 * one is in flight is refused (it resolves undefined without starting), and `busy` with `subscribe` lets
 * the controls disable themselves meanwhile.
 */

export interface OperationLock {
  readonly busy: boolean;
  subscribe: (listener: () => void) => () => void;
  /** Runs the job unless another is in flight, in which case it resolves undefined without starting. */
  run: <T>(job: () => Promise<T>) => Promise<T | undefined>;
}

export function createLock(): OperationLock {
  let held = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  return {
    get busy() {
      return held;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async run<T>(job: () => Promise<T>): Promise<T | undefined> {
      if (held) return undefined;
      held = true;
      emit();
      try {
        return await job();
      } finally {
        held = false;
        emit();
      }
    },
  };
}
