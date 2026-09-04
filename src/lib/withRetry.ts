/*
 * The boot-read retry. A first read at launch can reject before the backend's managed state is ready:
 * the window boots and fires its first invokes the instant the webview loads, while setup() is still
 * standing up the resident state (the audio engine, the app state). That window clears within a moment,
 * so a boot read retries with backoff before giving up. Without it, a swallowed early rejection reads as
 * "empty" and strands the launch on the wrong path - a stocked library on onboarding, or a file-open on
 * the full library instead of the standalone player. An EMPTY result is not a rejection, so a genuinely
 * empty read still resolves at once; only a thrown rejection retries.
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
