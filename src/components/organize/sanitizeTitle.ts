/*
 * Strips the trailing bracket junk a ripper or an export tacks onto a title - the "(128kbit_AAC)" and
 * "[guitar/study music]" tails - down to the real name. Pure and deterministic: same title in, same
 * title out.
 */

/**
 * Peels trailing "(...)" or "[...]" groups off the end of a title, one per pass, stopping before the
 * peel would leave the title blank. A name that is nothing but a bracketed group keeps that group.
 * Leading and trailing whitespace is trimmed. Returns the cleaned title.
 */
export function sanitizeTitle(title: string): string {
  let current = title.trim();
  for (;;) {
    // The last "(...)" or "[...]" group with the whitespace before it. Neither class nests, so a group
    // holding its own kind of bracket does not match and the peel stops there.
    const match = current.match(/\s*(\([^()]*\)|\[[^\][]*\])$/);
    if (!match || match.index === undefined) break;
    const stem = current.slice(0, match.index).trimEnd();
    // A blank stem means the title is only this group; keep it rather than empty the title.
    if (stem === "") break;
    current = stem;
  }
  return current;
}
