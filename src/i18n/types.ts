/*
 * The i18n primitives: a count-driven leaf and the set of supported locales. A dictionary leaf is
 * either a plain string (with `{name}` interpolation slots) or a Plural chosen by a count.
 */

/** A count-driven leaf: `one` for a count of 1, `other` otherwise. */
export interface Plural {
  one: string;
  other: string;
}

/** The supported locales. English is the default and the source of truth. */
export type Locale = "en" | "fr";
