/*
 * The backend's refusals that mean "try again later", matched by their text in one place. A scan holds
 * the library lock under one wording, a batch writing to music files under another, so a surface can
 * word each for the user instead of showing the raw message.
 */

/** What holds the lock: a library scan, or a write to the user's music files. */
export type BusyKind = "scan" | "fileWrite";

const SCAN_BUSY = "a scan is already running";
const FILE_WRITE_BUSY = "a file write is running";
const UNFINISHED_WRITES = "unfinished writes";

/** Which kind of busy refusal a rejection is, or null for any other failure. */
export function busyKind(error: unknown): BusyKind | null {
  const text = String(error);
  if (text.includes(SCAN_BUSY)) return "scan";
  if (text.includes(FILE_WRITE_BUSY)) return "fileWrite";
  return null;
}

/** Whether a root removal or relocation was refused because files under it have unfinished writes. */
export function isUnfinishedWrites(error: unknown): boolean {
  return String(error).includes(UNFINISHED_WRITES);
}
