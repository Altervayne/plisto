// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { TagAlbumsRailCard } from "../organize/albumsFromTags/TagAlbumsRailCard";

// -- State Imports --
import { useTagEntry } from "../../state/organize/tagProposals";

/**
 * The one notice slot under the rail's Files rows. Candidates are listed in precedence order and the
 * first that has something to say takes the slot, so two notices never stack.
 */
export function RailNotice({ onReviewTags }: { onReviewTags: () => void }) {
  const tags = useTagEntry();
  const candidates: (ReactNode | null)[] = [
    tags ? <TagAlbumsRailCard albumCount={tags.summary.albumCount} onReview={onReviewTags} /> : null,
  ];
  return <>{candidates.find((candidate) => candidate != null) ?? null}</>;
}
