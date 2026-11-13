/** One block of the release notes: a heading, a paragraph, or a run of bullets. */
export type NotesBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

const BULLET = "- ";

/**
 * Splits the notes' plain text into blocks. A line starting with "- " is a bullet and consecutive bullets
 * form one list. Any other non-empty line is a heading when the next non-empty line is a bullet, and a
 * paragraph otherwise. Blank lines only separate; nothing else is interpreted, so no markup ever reaches
 * the screen as anything but text.
 */
export function parseNotes(notes: string): NotesBlock[] {
  const lines = notes
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const blocks: NotesBlock[] = [];
  let list: string[] | null = null;

  const nextIsBullet = (from: number): boolean => {
    for (let i = from + 1; i < lines.length; i++) {
      if (lines[i]) return lines[i].startsWith(BULLET);
    }
    return false;
  };

  lines.forEach((line, index) => {
    if (!line) {
      list = null;
      return;
    }
    if (line.startsWith(BULLET)) {
      const text = line.slice(BULLET.length).trim();
      if (!list) {
        list = [];
        blocks.push({ kind: "list", items: list });
      }
      list.push(text);
      return;
    }
    list = null;
    blocks.push({ kind: nextIsBullet(index) ? "heading" : "paragraph", text: line });
  });
  return blocks;
}
