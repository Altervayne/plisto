/*
 * The text folds. `fold` is the comparison form of a tag, the same fold the backend applies to genre
 * keys, so both sides agree on what counts as one spelling. `searchFold` goes further for matching
 * typed text: it drops accents, so a query typed without them still finds the accented name.
 */

/** Whitespace runs collapse to one space, ends trim, NFC, lowercase. */
export function fold(s: string): string {
  return s.replace(/\s+/g, " ").trim().normalize("NFC").toLowerCase();
}

/** `fold`, then every combining mark stripped, so "eloise" and "éloïse" fold alike. */
export function searchFold(s: string): string {
  return fold(s).normalize("NFD").replace(/\p{M}/gu, "");
}
