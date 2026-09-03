/*
 * The quit-warning subject composer: turns the running-job display names into one capitalized clause
 * for the confirm prompt. Pure, so the joining and casing stay testable apart from the dialog and its
 * localized fragments.
 */

/**
 * Joins job subjects into one clause, capitalized to lead a sentence: "A library scan and an export".
 * `and` is the localized conjunction. A single name is returned capitalized; an empty list yields "".
 */
export function joinJobSubjects(names: string[], and: string): string {
  const joined =
    names.length <= 1
      ? names[0] ?? ""
      : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
