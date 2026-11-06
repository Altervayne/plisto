/*
 * The priority fold behind the selection bars: given each action's measured width and keep rank, it picks
 * which actions move into the trailing More menu so the row fits one line. Pure arithmetic with no DOM,
 * so the rules stay deterministic and testable.
 */

/** One action as the fold sees it: its measured width, how long it stays, and the group it belongs to. */
export interface FoldItem {
  id: string;
  width: number;
  /** Lower stays longer; 1 never folds. Higher ranks fold first. */
  keep: number;
  /** Adjacent items of different groups are parted by a separator. */
  group: number;
}

export interface FoldInput {
  /** The actions in display order. */
  items: FoldItem[];
  /** The width the whole row may use. */
  available: number;
  /** The flex gap between row children. */
  gap: number;
  /** A separator's outer width, margins included. 0 when the row has none. */
  sepWidth: number;
  /** The More trigger's width; counted only when something folds. */
  moreWidth: number;
  /** The always-visible trailing control (Clear). */
  trailingWidth: number;
}

export interface FoldResult {
  /** Ids moved into More, in display order. */
  folded: string[];
  /** Ids of visible items that carry a separator before them. */
  separated: Set<string>;
}

/** The ids that show a separator before them: a visible item whose visible predecessor is another group. */
function separatorsFor(visible: FoldItem[], sepWidth: number): Set<string> {
  const separated = new Set<string>();
  if (sepWidth <= 0) return separated;
  visible.forEach((item, index) => {
    if (index > 0 && visible[index - 1].group !== item.group) separated.add(item.id);
  });
  return separated;
}

/** The row's total width for a visible set, counting the separators, More (when any folded) and trailing. */
function rowWidth(visible: FoldItem[], anyFolded: boolean, input: FoldInput): number {
  const separators = separatorsFor(visible, input.sepWidth).size;
  const children = visible.length + separators + (anyFolded ? 1 : 0) + 1;
  const content =
    visible.reduce((sum, item) => sum + item.width, 0) +
    separators * input.sepWidth +
    (anyFolded ? input.moreWidth : 0) +
    input.trailingWidth;
  return content + input.gap * (children - 1);
}

/**
 * Folds the highest-rank actions first (ties fold the later one first) until the row fits `available`.
 * Rank 1 never folds, so a row that still overflows after every other action is gone keeps them.
 * A separator survives only between two groups that both still have a visible action.
 */
export function foldActions(input: FoldInput): FoldResult {
  const foldedIds = new Set<string>();
  const order = input.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.keep > 1)
    .sort((a, b) => b.item.keep - a.item.keep || b.index - a.index);

  let visible = input.items;
  for (const { item } of order) {
    if (rowWidth(visible, foldedIds.size > 0, input) <= input.available) break;
    foldedIds.add(item.id);
    visible = input.items.filter((entry) => !foldedIds.has(entry.id));
  }

  return {
    folded: input.items.filter((item) => foldedIds.has(item.id)).map((item) => item.id),
    separated: separatorsFor(visible, input.sepWidth),
  };
}
