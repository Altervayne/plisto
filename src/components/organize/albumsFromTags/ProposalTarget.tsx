// -- Component Imports --
import { SegmentedControl } from "../../common/SegmentedControl";
import { Select } from "../../common/Select/Select";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { TagAlbumProposal } from "../../../state/organize/groupByAlbumTags";
import type { TargetChoice } from "../../../state/organize/tagAlbumReview";
import type { SelectOption } from "../../common/Select/Select";

// -- Style Imports --
import styles from "./ProposalRow.module.css";

// Select values for the two non-album choices; an album choice is its id.
const UNSET = "";
const NEW = "new";

/**
 * Where a matched proposal files. One matching album offers a two-way toggle between adding to it and
 * a new album; several offer a pick among them, with none chosen until the user picks.
 */
export function ProposalTarget({
  proposal,
  choice,
  disabled,
  onChoose,
}: {
  proposal: TagAlbumProposal;
  choice: TargetChoice;
  disabled: boolean;
  onChoose: (choice: TargetChoice) => void;
}) {
  const t = useT();
  const label = t((d) => d.tagAlbums.targetLabel);
  // An unpicked row is headed for one of its albums too, so it reads the same as a picked one.
  const adds =
    choice.kind !== "new" ? t((d) => d.tagAlbums.addsTo, { n: proposal.tracks.length }) : null;

  if (proposal.matches.length === 1) {
    const albumId = proposal.matches[0].album.id;
    return (
      <div className={styles.target} data-disabled={disabled ? "" : undefined}>
        {adds ? <span className={styles.adds}>{adds}</span> : null}
        <SegmentedControl<"existing" | "new">
          label={label}
          value={choice.kind === "existing" ? "existing" : "new"}
          onChange={(value) =>
            onChoose(value === "existing" ? { kind: "existing", albumId } : { kind: "new" })
          }
          segments={[
            { value: "existing", label: t((d) => d.tagAlbums.targetExisting) },
            { value: "new", label: t((d) => d.tagAlbums.targetNew) },
          ]}
        />
      </div>
    );
  }

  const options: SelectOption[] = [
    { value: UNSET, label: t((d) => d.tagAlbums.pickAlbum) },
    ...proposal.matches.map(({ album }) => ({
      value: String(album.id),
      label: album.title ?? t((d) => d.albums.untitled),
      hint: [
        album.year != null ? String(album.year) : null,
        t((d) => d.tagAlbums.trackCount, { n: album.track_count }),
      ]
        .filter((part): part is string => part != null)
        .join(" - "),
    })),
    { value: NEW, label: t((d) => d.tagAlbums.targetNew) },
  ];
  const value =
    choice.kind === "existing" ? String(choice.albumId) : choice.kind === "new" ? NEW : UNSET;

  return (
    <div className={styles.target} data-disabled={disabled ? "" : undefined}>
      {adds ? <span className={styles.adds}>{adds}</span> : null}
      <Select
        showHint
        ariaLabel={label}
        value={value}
        options={options}
        onChange={(next) =>
          onChoose(
            next === UNSET
              ? { kind: "unset" }
              : next === NEW
                ? { kind: "new" }
                : { kind: "existing", albumId: Number(next) },
          )
        }
      />
    </div>
  );
}
