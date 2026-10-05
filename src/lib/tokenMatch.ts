/*
 * The one text-search predicate: a query folds and splits into tokens, and a set of fields matches when
 * every token sits somewhere in one of them. The quick finder and the track grid both filter through
 * this, so a count one shows is the count the other lands on.
 */

// -- Utils Imports --
import { searchFold } from "./fold";

/** The query folded and split on whitespace. A blank query has none. */
export function searchTokens(query: string): string[] {
  const folded = searchFold(query);
  return folded === "" ? [] : folded.split(" ");
}

/** Whether every token is a substring of at least one already-folded field. No tokens match anything. */
export function matchesTokens(fields: readonly string[], tokens: readonly string[]): boolean {
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}
