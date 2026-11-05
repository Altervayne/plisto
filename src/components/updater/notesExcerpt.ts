/** The longest excerpt the prompt shows before it stops adding lines. */
const EXCERPT_CHARS = 220;

/**
 * The opening lines of an update's release notes, for the prompt. Blank lines drop, line breaks stay, and
 * whole lines are added until the budget runs out; the first line always shows, clamped by the prompt.
 */
export function notesExcerpt(notes: string): string {
  const lines = notes
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 0 && used + line.length > EXCERPT_CHARS) break;
    kept.push(line);
    used += line.length;
  }
  return kept.join("\n");
}
