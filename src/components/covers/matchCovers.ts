/*
 * Filename cover matching: pairs a folder's loose images with its tracks by shared stem. A track named
 * "01 - Song.mp3" claims an image "01 - Song.jpg" sitting beside it, compared with the final extension
 * stripped and case folded. Pure and deterministic - the preview drives the actual binding.
 */

/** One image bound to one track by a shared filename stem, with both display names for the preview. */
export interface CoverMatch {
  trackId: number;
  trackFilename: string;
  imagePath: string;
  imageName: string;
}

/** The basename of a path, either separator; a bare filename comes back unchanged. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The filename stem: the basename minus its final extension, lowercased and trimmed. */
export function stemOf(filename: string): string {
  const base = baseName(filename);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.toLowerCase().trim();
}

/**
 * Pairs each track with a loose image sharing its stem, case-insensitively. Images are considered in
 * sorted order so the pick is deterministic, and each image binds at most once. A track with no stem or
 * no match is skipped; an image that matches no track is left out.
 */
export function matchStemPairs(
  images: string[],
  tracks: { id: number; filename: string }[],
): CoverMatch[] {
  const sorted = [...images].sort((a, b) => a.localeCompare(b));
  const taken = new Set<string>();
  const matches: CoverMatch[] = [];
  for (const track of tracks) {
    const stem = stemOf(track.filename);
    if (!stem) continue;
    const image = sorted.find((img) => !taken.has(img) && stemOf(img) === stem);
    if (!image) continue;
    taken.add(image);
    matches.push({
      trackId: track.id,
      trackFilename: track.filename,
      imagePath: image,
      imageName: baseName(image),
    });
  }
  return matches;
}
