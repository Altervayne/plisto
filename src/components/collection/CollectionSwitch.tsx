// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- Unit Imports --
import { segmentViews, switchShows } from "./collectionSegments";

// -- Type Imports --
import type { CollectionSegment } from "../../state/collection/store";
import type { SegmentCounts } from "./collectionSegments";
import type { Dict } from "../../i18n/en";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CollectionSwitch.module.css";

const LABEL: Record<CollectionSegment, (d: Dict) => string> = {
  browse: (d) => d.collection.browse,
  albums: (d) => d.collection.albums,
  singles: (d) => d.collection.singles,
  tracks: (d) => d.collection.tracks,
};

/**
 * The Collection's segment switch, centred in the controls strip. Counts trail as plain tabular text
 * and an empty Singles dims in place. With one segment left there is nothing to switch, so it renders
 * nothing. `hint` hangs under the switch, centred on it.
 */
export function CollectionSwitch({
  visible,
  segment,
  counts,
  onChange,
  hint,
}: {
  visible: CollectionSegment[];
  segment: CollectionSegment;
  counts: SegmentCounts;
  onChange: (segment: CollectionSegment) => void;
  hint?: ReactNode;
}) {
  const t = useT();
  if (!switchShows(visible)) return null;
  return (
    <div className={styles.switch}>
      <SegmentedControl
        label={t((d) => d.collection.switchLabel)}
        value={segment}
        onChange={onChange}
        segments={segmentViews(visible, counts).map((view) => ({
          value: view.id,
          label: t(LABEL[view.id]),
          count: view.count ?? undefined,
          dimmed: view.dimmed,
        }))}
      />
      {hint}
    </div>
  );
}
