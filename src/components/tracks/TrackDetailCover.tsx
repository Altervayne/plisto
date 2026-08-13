// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverActions } from "../common/CoverActions/CoverActions";
import { QuietButton } from "../common/QuietButton";

// -- Hook Imports --
import { useTrackCover } from "./useTrackCover";

// -- Type Imports --
import type { TrackRow } from "../../types";
import type { CandidateView, CoverView } from "./useTrackCover";

// -- Style Imports --
import styles from "./TrackDetailCover.module.css";

/** The trailing filename of a path, split on either separator so it reads on every platform. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The provenance line for the resolved cover, naming the folder image when one is showing. */
function provenanceOf(cover: CoverView, candidates: CandidateView[]): string {
  switch (cover.source) {
    case "embedded":
      return "Embedded in file";
    case "adjacent": {
      const adjacent = candidates.find((c) => c.source === "adjacent");
      return adjacent?.originPath
        ? `In this folder: ${fileName(adjacent.originPath)}`
        : "In this folder";
    }
    case "imported":
      return "Added by you (cached) - not written to your files";
  }
}

/** A short label for a candidate in the strip: the source, or the adjacent image's filename. */
function candidateLabelOf(candidate: CandidateView): string {
  if (candidate.source === "embedded") return "Embedded in file";
  if (candidate.source === "adjacent" && candidate.originPath) {
    return fileName(candidate.originPath);
  }
  return "Added by you";
}

/**
 * The cover surface at the top of the detail peek: the resolved art (glass Replace on hover) or a
 * sunken Add-cover recess, its provenance, the other available sources, and Remove for a cover the
 * user added. All cover logic lives in the hook; this only renders and wires the actions.
 */
export function TrackDetailCover({ track }: { track: TrackRow }) {
  const { cover, candidates, error, importFromDisk, useCandidate, remove } = useTrackCover(
    track.id,
  );

  return (
    <section className={styles.section} aria-label="Cover">
      {cover ? (
        <div className={styles.slot}>
          <Cover src={cover.src} alt="" />
          <CoverActions actions={[{ label: "Replace cover", onClick: () => void importFromDisk() }]} />
        </div>
      ) : (
        <button
          type="button"
          className={styles.addSlot}
          onClick={() => void importFromDisk()}
          aria-label="Add cover"
        >
          <Cover src={null} />
          <span className={styles.addHint}>Add cover</span>
        </button>
      )}

      {cover ? (
        <p className={styles.provenance}>{provenanceOf(cover, candidates)}</p>
      ) : (
        <p className={styles.provenance}>No cover found</p>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}

      {candidates.length > 0 ? (
        <ul className={styles.candidates}>
          {candidates.map((candidate) => (
            <li key={candidate.src} className={styles.candidate}>
              <span className={styles.candidateThumb}>
                <Cover src={candidate.src} alt="" />
              </span>
              <span className={styles.candidateLabel}>{candidateLabelOf(candidate)}</span>
              {candidate.source === "adjacent" && candidate.originPath ? (
                <QuietButton onClick={() => void useCandidate(candidate)}>Use this</QuietButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {cover?.source === "imported" ? (
        <QuietButton onClick={() => void remove()}>Remove the cover you added</QuietButton>
      ) : null}

      <p className={styles.safety}>covers embed into the exported copy, never your originals</p>
    </section>
  );
}
