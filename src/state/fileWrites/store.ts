/*
 * The writing-to-music-files store: which sheet is open, the scope it covers, the batch that is running,
 * and the recovery report waiting to be shown. A recovery that arrives while another is showing adds to
 * it, so a boot report and a later scan report read as one notice.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Utils Imports --
import { STAMP_ENABLED } from "../../lib/features";

// -- Type Imports --
import type { StampScope, WriteRecovery } from "../../types";

/**
 * The sheet the host shows: the tag-write sheet over a scope, the same sheet opened on the undo of a
 * finished batch, or the kept backups list.
 */
export type FileWritesSheet =
  | { kind: "stamp"; scope: StampScope }
  | { kind: "stampUndo"; batchId: number }
  | { kind: "kept" };

/** What a recovery report holds once there is something to say. */
export type RecoveryReport = NonNullable<WriteRecovery>;

/** The batch in flight: a write or an undo, how many files it has handled of how many. */
export interface RunningBatch {
  kind: "stamp" | "undo";
  done: number;
  total: number;
}

interface FileWritesStore {
  sheet: FileWritesSheet | null;
  recovery: RecoveryReport | null;
  running: RunningBatch | null;
  /** Epoch ms of the last refusal because a file write held the lock; null once dismissed. */
  busyAt: number | null;

  openStamp: (scope: StampScope) => void;
  openStampUndo: (batchId: number) => void;
  openKept: () => void;
  closeSheet: () => void;
  /** Takes a report from the backend; an empty one, or null, changes nothing. */
  showRecovery: (report: WriteRecovery) => void;
  dismissRecovery: () => void;
  startRun: (kind: RunningBatch["kind"], total: number) => void;
  setRunDone: (done: number) => void;
  endRun: () => void;
  showBusy: () => void;
  dismissBusy: () => void;
}

/** Whether a report has anything to tell the user. */
export function hasRecoveryNews(report: WriteRecovery): report is RecoveryReport {
  if (report == null) return false;
  return report.restored + report.finished + report.heldOffline > 0 || report.needsAttention.length > 0;
}

export const useFileWritesStore = create<FileWritesStore>((set) => ({
  sheet: null,
  recovery: null,
  running: null,
  busyAt: null,

  openStamp: (scope) => set({ sheet: { kind: "stamp", scope } }),
  openStampUndo: (batchId) => set({ sheet: { kind: "stampUndo", batchId } }),
  openKept: () => set({ sheet: { kind: "kept" } }),
  closeSheet: () => set({ sheet: null }),

  showRecovery: (report) => {
    if (!hasRecoveryNews(report)) return;
    set((s) => {
      const held = s.recovery;
      if (!held) return { recovery: report };
      // Files held offline are a standing state, so the latest count replaces the earlier one.
      return {
        recovery: {
          restored: held.restored + report.restored,
          finished: held.finished + report.finished,
          heldOffline: report.heldOffline,
          needsAttention: [
            ...held.needsAttention,
            ...report.needsAttention.filter((p) => !held.needsAttention.includes(p)),
          ],
        },
      };
    });
  },
  dismissRecovery: () => set({ recovery: null }),

  startRun: (kind, total) => set({ running: { kind, done: 0, total } }),
  setRunDone: (done) => set((s) => (s.running ? { running: { ...s.running, done } } : s)),
  endRun: () => set({ running: null }),

  showBusy: () => set({ busyAt: Date.now() }),
  dismissBusy: () => set({ busyAt: null }),
}));

// -- Actions for callers outside React (menu builders, handlers) --

/** Opens the tag-write sheet over `scope`. Does nothing while tag writing is switched off. */
export function openStampSheet(scope: StampScope): void {
  if (!STAMP_ENABLED) return;
  useFileWritesStore.getState().openStamp(scope);
}

/** Opens the tag-write sheet on the undo confirm of batch `batchId`. Does nothing while tag writing is off. */
export function openStampUndo(batchId: number): void {
  if (!STAMP_ENABLED) return;
  useFileWritesStore.getState().openStampUndo(batchId);
}

/** Shows the notice that a file write is running. Callable from stores and handlers. */
export function showFileWriteBusy(): void {
  useFileWritesStore.getState().showBusy();
}

/** Opens the kept backups list. */
export function openKeptBackups(): void {
  useFileWritesStore.getState().openKept();
}

// -- Selectors (narrow: each returns one slice or one action reference) --

export const useFileWritesSheet = (): FileWritesSheet | null => useFileWritesStore((s) => s.sheet);
export const useFileWritesRecovery = (): RecoveryReport | null => useFileWritesStore((s) => s.recovery);
export const useFileWritesRunning = (): RunningBatch | null => useFileWritesStore((s) => s.running);
export const useFileWritesBusyAt = (): number | null => useFileWritesStore((s) => s.busyAt);
export const useCloseFileWritesSheet = () => useFileWritesStore((s) => s.closeSheet);
