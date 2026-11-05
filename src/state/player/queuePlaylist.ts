/*
 * Turns the queue into the track list of a saved playlist. Ad-hoc ids (negative, files opened from disk
 * with no library row) have no playlist slot to occupy, so they are dropped; the rest keep play order,
 * repeats included.
 */

/** The library track ids of the queue, in play order. */
export function queuePlaylistTrackIds(queue: number[]): number[] {
  return queue.filter((id) => id > 0);
}

/** The default playlist name: the localized label then the local date, e.g. "Queue 2026-11-05". */
export function queuePlaylistName(label: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${label} ${date}`;
}
