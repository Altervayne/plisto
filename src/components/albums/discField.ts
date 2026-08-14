/*
 * Maps a track's disc between its numeric column and the text field that edits it. A blank, non-
 * numeric, or below-one entry clears the disc to null (unset), which resolves to disc 1 - never a
 * stored zero.
 */

/** Parses a disc field's text into the numeric column, or null when it is blank or below one. */
export function parseDisc(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const disc = Number(trimmed);
  return disc >= 1 ? disc : null;
}

/** Renders a disc number for its text field, folding an unset disc to an empty string. */
export function formatDisc(disc: number | null): string {
  return disc != null ? String(disc) : "";
}
