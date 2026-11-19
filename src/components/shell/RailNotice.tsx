// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { GoneRailCard } from "../gone/GoneRailCard";
import { TagAlbumsRailCard } from "../organize/albumsFromTags/TagAlbumsRailCard";

// -- State Imports --
import { useGoneEntry } from "../../state/gone/goneEntry";
import { useTagEntry } from "../../state/organize/tagProposals";
import { useOpenGone } from "../../state/shell/store";

/**
 * The one notice slot under the rail's Files rows. Candidates are listed in precedence order and the
 * first that has something to say takes the slot, so two notices never stack. Tracks that cannot be
 * found are a fault and outrank the albums offer, which returns once they are fixed or set aside.
 */
export function RailNotice({ onReviewTags }: { onReviewTags: () => void }) {
  const gone = useGoneEntry();
  const tags = useTagEntry();
  const openGone = useOpenGone();
  const candidates: (ReactNode | null)[] = [
    gone ? <GoneRailCard total={gone.summary.total} onReview={() => openGone()} onDismiss={gone.dismiss} /> : null,
    tags ? <TagAlbumsRailCard albumCount={tags.summary.albumCount} onReview={onReviewTags} /> : null,
  ];
  return <>{candidates.find((candidate) => candidate != null) ?? null}</>;
}
