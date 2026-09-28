// -- Framework Imports --
import { useState } from "react";

// -- Icon Imports --
import { ChevronDown } from "lucide-react";

// -- Component Imports --
import { ProposalChips } from "./ProposalChips";
import { ProposalCover } from "./ProposalCover";
import { ProposalTarget } from "./ProposalTarget";
import { ProposalTracks } from "./ProposalTracks";

// -- State Imports --
import { checkFirst, visibleNotes } from "../../../state/organize/tagAlbumReview";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { TagAlbumProposal } from "../../../state/organize/groupByAlbumTags";
import type { TargetChoice } from "../../../state/organize/tagAlbumReview";

// -- Style Imports --
import styles from "./ProposalRow.module.css";

/**
 * One proposed album: a checkbox over its cover, title, meta line and chips, a target control when its
 * tags match an existing album, and a toggle that lists its tracks in play order. A row with no target
 * picked yet cannot be checked.
 */
export function ProposalRow({
  proposal,
  checked,
  choice,
  disabled,
  onToggle,
  onChoose,
}: {
  proposal: TagAlbumProposal;
  checked: boolean;
  choice: TargetChoice;
  disabled: boolean;
  onToggle: () => void;
  onChoose: (choice: TargetChoice) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const title = proposal.fields.title ?? proposal.title;
  const meta = [
    proposal.fields.album_artist,
    proposal.fields.year != null ? String(proposal.fields.year) : null,
    t((d) => d.tagAlbums.trackCount, { n: proposal.tracks.length }),
    proposal.discCount > 1 ? t((d) => d.tagAlbums.discs, { n: proposal.discCount }) : null,
  ]
    .filter((part): part is string => part != null)
    .join(" - ");

  return (
    <div className={styles.row} data-checked={checked ? "" : undefined}>
      <div className={styles.main}>
        <label className={styles.pick}>
          <input
            type="checkbox"
            className={styles.check}
            checked={checked}
            disabled={disabled || choice.kind === "unset"}
            onChange={onToggle}
          />
          <ProposalCover tracks={proposal.tracks} />
          <span className={styles.text}>
            <span className={styles.title} title={title}>
              {title}
            </span>
            <span className={styles.meta}>{meta}</span>
            <ProposalChips
              warnings={checkFirst(proposal, choice)}
              notes={visibleNotes(proposal, choice)}
            />
          </span>
        </label>
        <button
          type="button"
          className={styles.expand}
          aria-expanded={expanded}
          aria-label={expanded ? t((d) => d.tagAlbums.hideTracks) : t((d) => d.tagAlbums.showTracks)}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown size={16} className={expanded ? styles.chevronOpen : styles.chevron} />
        </button>
      </div>

      {proposal.matches.length > 0 ? (
        <ProposalTarget proposal={proposal} choice={choice} disabled={disabled} onChoose={onChoose} />
      ) : null}

      {expanded ? <ProposalTracks tracks={proposal.tracks} multiDisc={proposal.discCount > 1} /> : null}
    </div>
  );
}
