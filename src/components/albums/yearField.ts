/*
 * Maps an album year between its numeric column and the text field that edits it. A blank or
 * non-numeric entry clears the year to null (unset), never a stored zero or empty string.
 */

/** Parses a year field's text into the numeric column, or null when it is blank or non-numeric. */
export function parseYear(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Renders the numeric year for its text field, folding an unset year to an empty string. */
export function formatYear(year: number | null): string {
  return year != null ? String(year) : "";
}
