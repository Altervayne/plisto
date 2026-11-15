/*
 * Which Settings section the reader is in, from the section tops and the scroll position. Pure so the
 * rule is testable without a DOM.
 */

/** How far below the viewport top a section counts as reached. */
export const ACTIVE_TOP_OFFSET = 40;

/** Slack, in pixels, for a scroll position that stops a fraction short of the end. */
const END_SLACK = 2;

/**
 * The index of the active section: the last one whose top has passed the offset line. The last
 * sections can be too short to ever reach the line, so a page scrolled to its end activates the last
 * section; a page that does not scroll at all stays on its first.
 *
 * `tops` are the section tops in page order, measured from the top of the scrolling content.
 */
export function activeSectionIndex(
  tops: readonly number[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): number {
  if (tops.length === 0) return 0;
  const scrolls = scrollHeight > clientHeight + END_SLACK;
  if (scrolls && scrollTop + clientHeight >= scrollHeight - END_SLACK) return tops.length - 1;
  let active = 0;
  tops.forEach((top, i) => {
    if (top <= scrollTop + ACTIVE_TOP_OFFSET) active = i;
  });
  return active;
}
