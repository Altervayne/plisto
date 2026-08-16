// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverActions } from "../common/CoverActions/CoverActions";
import { FolderImagePicker } from "./FolderImagePicker";
import { QuietButton } from "../common/QuietButton";
import { StaffSpinner } from "../scan/StaffSpinner";

// -- Hook Imports --
import { useTrackCover } from "./useTrackCover";

// -- Type Imports --
import type { TrackRow } from "../../types";
import type { CandidateView, CoverView } from "./useTrackCover";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Translate } from "../../i18n";

// -- Style Imports --
import styles from "./TrackDetailCover.module.css";

/** The trailing filename of a path, split on either separator so it reads on every platform. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A default save name for the cover: the track's filename stem with the art's real extension. */
function coverSaveName(filename: string, ext: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return `${stem || filename}.${ext}`;
}

/** The provenance line for the resolved cover, naming the folder image when one is showing. */
function provenanceOf(cover: CoverView, candidates: CandidateView[], t: Translate): string {
  switch (cover.source) {
    case "embedded":
      return t((d) => d.cover.embedded);
    case "adjacent": {
      const adjacent = candidates.find((c) => c.source === "adjacent");
      const origin = adjacent?.originPath;
      return origin
        ? t((d) => d.cover.inFolder, { name: fileName(origin) })
        : t((d) => d.cover.inFolderPlain);
    }
    case "imported":
      return t((d) => d.cover.imported);
  }
}

/** A short label for a candidate in the strip: the source, or the adjacent image's filename. */
function candidateLabelOf(candidate: CandidateView, t: Translate): string {
  if (candidate.source === "embedded") return t((d) => d.cover.embedded);
  if (candidate.source === "adjacent" && candidate.originPath) {
    return fileName(candidate.originPath);
  }
  return t((d) => d.cover.addedByYou);
}

/**
 * The cover surface at the top of the detail peek: the resolved art (glass Replace on hover) or a
 * sunken Add-cover recess, its provenance, the other available sources, and Remove for a cover the
 * user added. All cover logic lives in the hook; this only renders and wires the actions.
 */
export function TrackDetailCover({
  track,
  keepOwn = false,
}: {
  track: TrackRow;
  keepOwn?: boolean;
}) {
  const {
    cover,
    candidates,
    loading,
    assigning,
    error,
    importFromDisk,
    assignFromPath,
    useCandidate,
    remove,
    saveToDisk,
  } = useTrackCover(track.id, keepOwn);
  const t = useT();
  const [picking, setPicking] = useState(false);

  // Loading has its own surface: a quiet, non-interactive slot while the resolve is in flight, so the
  // peek never claims "no cover found" before the cover has had a chance to arrive.
  const showLoading = loading && !cover;

  return (
    <section className={styles.section} aria-label={t((d) => d.cover.trackLabel)}>
      {assigning ? (
        // An assign/remove for this track is running: hold the current art (or the empty recess) under a
        // scrimmed staff spinner, and drop the actions so the picker can't be re-fired mid-flight.
        <div className={styles.slot} aria-busy="true">
          <Cover src={cover?.src ?? null} alt="" />
          <span className={styles.loading} aria-hidden="true">
            <StaffSpinner />
          </span>
        </div>
      ) : cover ? (
        <div className={styles.slot}>
          <Cover src={cover.src} alt="" />
          <CoverActions
            actions={[{ label: t((d) => d.cover.replace), onClick: () => void importFromDisk() }]}
          />
        </div>
      ) : showLoading ? (
        <div className={styles.slot} aria-busy="true">
          <Cover src={null} />
        </div>
      ) : (
        <button
          type="button"
          className={styles.addSlot}
          onClick={() => void importFromDisk()}
          aria-label={t((d) => d.cover.add)}
        >
          <Cover src={null} />
          <span className={styles.addHint}>{t((d) => d.cover.add)}</span>
        </button>
      )}

      {assigning ? (
        <p className={styles.provenance}>{t((d) => d.cover.loading)}</p>
      ) : cover ? (
        <p className={styles.provenance}>{provenanceOf(cover, candidates, t)}</p>
      ) : showLoading ? (
        <p className={styles.provenance}>{t((d) => d.cover.loading)}</p>
      ) : (
        <p className={styles.provenance}>{t((d) => d.cover.none)}</p>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}

      {!assigning ? (
        <QuietButton onClick={() => setPicking(true)}>
          {t((d) => d.cover.pickFromFolder)}
        </QuietButton>
      ) : null}

      {candidates.length > 0 ? (
        <ul className={styles.candidates}>
          {candidates.map((candidate) => (
            <li key={candidate.src} className={styles.candidate}>
              <span className={styles.candidateThumb}>
                <Cover src={candidate.src} alt="" />
              </span>
              <span className={styles.candidateLabel}>{candidateLabelOf(candidate, t)}</span>
              {candidate.source === "adjacent" && candidate.originPath ? (
                <QuietButton onClick={() => void useCandidate(candidate)}>
                  {t((d) => d.cover.useThis)}
                </QuietButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {cover ? (
        <QuietButton
          onClick={() =>
            void saveToDisk((ext) => coverSaveName(track.filename, ext), t((d) => d.cover.saveError))
          }
        >
          {t((d) => d.cover.saveToDisk)}
        </QuietButton>
      ) : null}

      {cover?.source === "imported" ? (
        <QuietButton onClick={() => void remove()}>{t((d) => d.cover.removeAdded)}</QuietButton>
      ) : null}

      <p className={styles.safety}>{t((d) => d.cover.embedNote)}</p>

      {picking ? (
        <FolderImagePicker
          trackId={track.id}
          onPick={(path) => void assignFromPath(path)}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </section>
  );
}
