// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip";

// -- Icon Imports --
import { FolderOpen } from "lucide-react";

// -- Hook Imports --
import { useTrackThumb } from "../covers/useTrackThumb";

// -- Utils Imports --
import { middleEllipsis } from "../../lib/middleEllipsis";
import { revealFile } from "../../lib/opener";

// -- Type Imports --
import type { CopyFacts, CopyField } from "./copyFacts";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./DuplicateSetCard.module.css";

/** The folder path's longest shown length before its middle is cut. */
const FOLDER_CHARS = 38;

/**
 * One copy in a duplicate set: its cover, file facts, placement and listening history, then Keep this
 * one and Show in folder. A fact that differs across the set reads in full ink, a shared one stays dim.
 */
export function DuplicateCopy({
  copy,
  differing,
  busy,
  onKeep,
}: {
  copy: CopyFacts;
  differing: Set<CopyField>;
  busy: boolean;
  onKeep: () => void;
}) {
  const t = useT();
  const thumb = useTrackThumb(copy.id);
  const tone = (field: CopyField) => (differing.has(field) ? styles.differs : styles.same);

  const keep = (
    <button type="button" className={styles.keep} disabled={busy || copy.gone} onClick={onKeep}>
      {t((d) => d.duplicates.keep)}
    </button>
  );

  return (
    <div className={styles.copy}>
      <div className={styles.thumb}>
        <Cover src={thumb} />
      </div>

      <div className={styles.facts}>
        <span className={`${styles.filename} ${tone("filename")}`}>{copy.filename}</span>
        <Tooltip label={copy.folder}>
          <span className={`${styles.folder} ${tone("folder")}`} tabIndex={0}>
            {middleEllipsis(copy.folder, FOLDER_CHARS)}
          </span>
        </Tooltip>
        <span className={styles.line}>
          <span className={tone("format")}>{copy.format}</span>
          {" - "}
          <span className={tone("size")}>{copy.size}</span>
          {" - "}
          <span className={tone("duration")}>{copy.duration}</span>
        </span>
        <span className={`${styles.line} ${tone("placement")}`}>{copy.placement}</span>
        <span className={`${styles.line} ${tone("playlists")}`}>
          {t((d) => d.duplicates.inPlaylists, { n: copy.playlists })}
        </span>
        {copy.plays != null ? (
          <span className={`${styles.line} ${tone("plays")}`}>
            {t((d) => d.duplicates.played, { n: copy.plays })}
          </span>
        ) : null}
        {copy.identical ? <span className={styles.tag}>{t((d) => d.duplicates.identical)}</span> : null}
      </div>

      <div className={styles.copyActions}>
        {copy.gone ? (
          <Tooltip label={t((d) => d.player.fileMissing)}>
            <span className={styles.tipWrap} tabIndex={0}>
              {keep}
            </span>
          </Tooltip>
        ) : (
          keep
        )}
        <QuietButton onClick={() => void revealFile(copy.sourcePath)}>
          <FolderOpen size={15} strokeWidth={1.8} aria-hidden="true" />
          {t((d) => d.tracks.goToFile)}
        </QuietButton>
      </div>
    </div>
  );
}
