/*
 * Keyboard movement for a short vertical menu: which entry a key moves focus to.
 */

/** The entry index a key moves to, or null when the key does not move within the menu. */
export function menuKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, count - 1);
    case "ArrowUp":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
