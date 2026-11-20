// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- State Imports --
import { useFileWritesStore } from "../../state/fileWrites/store";
import { useScanStatus } from "../../state/store";

// -- Type Imports --
import type { WriteRecovery } from "../../types";

// -- IPC Imports --
import { takeFileWriteRecovery } from "../../lib/ipc";
import { withRetry } from "../../lib/withRetry";

/** Takes one report and hands it on. Never cancelled: the backend clears a report once it is taken. */
export function takeAndShow(take: () => Promise<WriteRecovery>, show: (report: WriteRecovery) => void): void {
  take()
    .then(show)
    .catch(() => {});
}

/** Boot attempts: a cold-start rejection must not read as "nothing to report". */
const BOOT_ATTEMPTS = 6;

/**
 * Takes one report with the boot-read retry, one attempt at a time, so a report is never taken twice in
 * parallel. Once `live` turns false the retries stop and take nothing further; a take already in flight
 * still lands, since the backend cleared its report.
 */
export function takeWithRetry(
  take: () => Promise<WriteRecovery>,
  show: (report: WriteRecovery) => void,
  live: () => boolean,
): Promise<void> {
  return withRetry(() => (live() ? take() : Promise.resolve(null)), BOOT_ATTEMPTS).then(show, () => {});
}

/**
 * Takes the backend's recovery report at mount and whenever a scan stops running, since a scan recovers
 * the roots that were offline at boot. A take clears the report on the backend, so a resolved take is
 * always applied, even after the status moved on. The mount take retries; the take after a scan is dropped when
 * it fails, and the report stays for the next try.
 */
export function useWriteRecovery(): void {
  const scanStatus = useScanStatus();
  const showRecovery = useFileWritesStore((s) => s.showRecovery);

  // True while the mount take is still retrying; a scan-stop take waits for it rather than racing it.
  const booting = useRef(false);

  useEffect(() => {
    let live = true;
    booting.current = true;
    void takeWithRetry(takeFileWriteRecovery, showRecovery, () => live).finally(() => {
      booting.current = false;
    });
    return () => {
      live = false;
    };
  }, [showRecovery]);

  useEffect(() => {
    if (scanStatus === "scanning" || booting.current) return;
    takeAndShow(takeFileWriteRecovery, showRecovery);
  }, [scanStatus, showRecovery]);
}
