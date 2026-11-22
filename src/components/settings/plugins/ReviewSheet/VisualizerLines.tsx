// -- Utils Imports --
import { addsVisualizers, listingMove } from "../../../../state/plugins/review";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewMode, ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/**
 * Where an installed plugin will be listed, or where an update moves it. Nothing for a plugin with no
 * visualizers, a review of an installed plugin, or an update that leaves the listing as it is.
 */
export function ListingLine({ subject, mode }: { subject: ReviewSubject; mode: ReviewMode }) {
  const t = useT();
  const move = listingMove(subject);
  const text =
    mode === "install" && addsVisualizers(subject) && subject.listing
      ? subject.listing === "catalog"
        ? t((d) => d.plugins.vis.listedVisualizers)
        : t((d) => d.plugins.vis.listedPlugins)
      : move && mode === "update"
        ? move === "plugins"
          ? t((d) => d.plugins.vis.movesToPlugins)
          : t((d) => d.plugins.vis.movesToVisualizers)
        : null;
  return text ? <div className={styles.box}>{text}</div> : null;
}

/** The safety note on every sheet of a plugin that draws visualizers: Plisto does not check for flashing. */
export function FlashNote({ subject }: { subject: ReviewSubject }) {
  const t = useT();
  if (!addsVisualizers(subject)) return null;
  return <p className={styles.note}>{t((d) => d.plugins.vis.flashNote)}</p>;
}
