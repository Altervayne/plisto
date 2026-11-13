/**
 * The release date the updater reports (RFC 3339) as a long date in `locale`, or null when it is absent or
 * unreadable. Read in UTC so the day shown is the day the release was stamped, wherever the user is.
 */
export function formatReleaseDate(date: string | null, locale: string): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(parsed);
}
