/** Shortens text to `max` characters by cutting its middle, so both the start and the end stay readable. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(2, max - 3);
  const head = Math.ceil(room / 2);
  const tail = Math.floor(room / 2);
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}
