/*
 * The boot-read retry. A first read at launch can reject before the backend's managed state is ready:
 * the window fires its first invokes while setup() is still standing up the resident state. A boot read
 * retries with backoff so a swallowed early rejection never reads as "empty" and strands the launch on
 * the wrong path. An empty result is not a rejection, so a genuinely empty read still resolves at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000, 250 * (i + 1))));
    }
  }
}
