/*
 * The refusal type and the small text rules the manifest checks share. They follow Plisto's own manifest
 * rules (path, label and clip), so an author sees the wording the installer would use.
 */

/** A rule the manifest breaks; `message` is the sentence Plisto would show. */
export class Refusal extends Error {}

export const ID_RULE = "must be 1 to 24 characters of a-z, 0-9 and '-'";
export const MAX_LABEL = 24;

const RESERVED = [
  "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "CONIN$", "CONOUT$",
];
const REL_PATH_MAX = 128;
const MAX_COMBINING_RUN = 6;
const INVISIBLE = new RegExp(
  "[\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]",
  "u",
);

/** The value, kept to 40 characters with control characters removed, as Plisto quotes a bad value. */
export const clip = (s) => [...String(s)].filter((c) => !/\p{Cc}/u.test(c)).slice(0, 40).join("");

export const validKindId = (id) => /^[a-z0-9-]{1,24}$/.test(id);

/** A relative path inside the plugin, or the reason it is refused. */
export function relPathProblem(path) {
  if (path === "") return "must not be empty";
  if (Buffer.byteLength(path) > REL_PATH_MAX) return "is too long";
  if (path.startsWith("/")) return "must be relative";
  if (path.includes("\\")) return "must use '/' separators";
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return "may only contain letters, digits, '.', '_', '-' and '/'";
  for (const part of path.split("/")) {
    if (part === "") return "must not contain an empty segment";
    if (part === "." || part === "..") return "must not contain '.' or '..' segments";
    if (part.endsWith(".")) return "a segment must not end with '.'";
    if (RESERVED.includes(part.split(".")[0].toUpperCase())) {
      return "a segment is a reserved Windows device name";
    }
  }
  return null;
}

/** Whether the file name ends in `ext` and has a stem. */
export function hasExt(path, ext) {
  const name = path.split("/").pop();
  return name.length > ext.length && name.toLowerCase().endsWith(ext);
}

function hasStackedMarks(s) {
  let run = 0;
  for (const c of s) {
    run = /\p{M}/u.test(c) ? run + 1 : 0;
    if (run > MAX_COMBINING_RUN) return true;
  }
  return false;
}

/** The reason a name or label Plisto shows is refused (1 to 24 characters of plain text), or null. */
export function labelProblem(s) {
  if (s.trim() === "") return "must not be empty";
  if (/\p{Cc}/u.test(s) || INVISIBLE.test(s)) return "contains control characters";
  if (hasStackedMarks(s)) return "has too many combining marks in a row";
  if ([...s].length > MAX_LABEL) return "is over 24 characters";
  return null;
}
