// -- Component Imports --
import { GroupMarkers } from "../tiles/GroupMarkers";

// -- Local Imports --
import { SHEET_GROUPS, SHEET_GROUP_LABELS, type SheetGroupId } from "./sheetGroups";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import segmentStyles from "../../../common/SegmentedControl.module.css";
import styles from "./GroupChips.module.css";

/** The dots a chip carries: filled for the active kind's group, ringed for a set-aside default's. */
export type ChipMarkers = Partial<Record<SheetGroupId, { active?: boolean; setAside?: boolean }>>;

/**
 * The strip's group chips, in the segmented-control shape: a chip jumps the strip to its group, and the
 * raised chip follows the group at the strip's left edge as it scrolls.
 */
export function GroupChips({
  current,
  onJump,
  markers,
}: {
  current: SheetGroupId;
  onJump: (id: SheetGroupId) => void;
  markers?: ChipMarkers;
}) {
  const t = useT();
  return (
    <div className={`${segmentStyles.control} ${styles.chips}`} role="group">
      {SHEET_GROUPS.map(({ id }) => (
        <button
          key={id}
          type="button"
          className={`${segmentStyles.segment} ${id === current ? segmentStyles.active : ""}`}
          aria-pressed={id === current}
          onClick={() => onJump(id)}
        >
          {t(SHEET_GROUP_LABELS[id])}
          <GroupMarkers {...markers?.[id]} />
        </button>
      ))}
    </div>
  );
}
