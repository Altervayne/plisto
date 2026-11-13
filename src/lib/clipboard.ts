/*
 * Writes text to the system clipboard. Resolves false when the webview refuses (no permission, no
 * focused document), so a caller can say it did not copy instead of claiming it did.
 */

/** Copies `text` to the clipboard; false when the write was refused. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
