/*
 * The i18n runtime. The active locale lives in the preferences store, so it persists through the
 * settings kv and hydrates on mount like every other pref. `useT` binds a `t` to the active dict and
 * selects each leaf by accessor, keeping every call fully typed with no stringly key. A `Plural` leaf
 * resolves by `n`, then `{name}` tokens interpolate from the passed vars. There is no English
 * fallback: an unfilled French leaf shows its "[TO COMPLETE]" placeholder verbatim, so a gap is
 * visible on sight.
 */

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../state/preferences/store";

// -- Local Imports --
import { en } from "./en";
import { fr } from "./fr";

// -- Type Imports --
import type { Dict } from "./en";
import type { Locale, Plural } from "./types";

const DICTS: Record<Locale, Dict> = { en, fr };

/** Interpolation and count vars: `n` drives a plural, and every key fills a `{name}` slot. */
type Vars = { n: number } & Record<string, string | number>;

/** The bound translator: a plain leaf takes optional vars, a plural leaf requires a count. */
export interface Translate {
  (pick: (d: Dict) => string, vars?: Record<string, string | number>): string;
  (pick: (d: Dict) => Plural, vars: Vars): string;
}

function isLocale(value: string | undefined): value is Locale {
  return value === "en" || value === "fr";
}

function isPlural(node: string | Plural): node is Plural {
  return typeof node === "object";
}

/** Fills each `{name}` token from vars; an unmatched token is left as written. */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** The active locale from the pref, validated and defaulted to English. */
export function useLocale(): Locale {
  const stored = usePreference(PREF_KEYS.locale);
  return isLocale(stored) ? stored : "en";
}

/** Sets the active locale through the persisted pref. */
export function useSetLocale(): (locale: Locale) => void {
  const setPreference = useSetPreference();
  return (locale) => setPreference(PREF_KEYS.locale, locale);
}

/** A `t` bound to the active locale's dict: resolve a leaf, choose its plural form, interpolate. */
export function useT(): Translate {
  const dict = DICTS[useLocale()];
  const t = (pick: (d: Dict) => string | Plural, vars?: Vars): string => {
    const node = pick(dict);
    const text = isPlural(node) ? (vars?.n === 1 ? node.one : node.other) : node;
    return interpolate(text, vars);
  };
  return t as Translate;
}
