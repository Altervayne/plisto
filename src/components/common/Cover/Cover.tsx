// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Style Imports --
import styles from "./Cover.module.css";

/**
 * A square cover-as-object: art when given a src, else the sunken placeholder recess. It carries
 * the soft shadow and the inset ring that make it read as a physical tile, plus a faint grain
 * layer. Presentational only - it never touches IPC or path conversion; the caller hands it a
 * ready src. A src that fails to load folds back to the placeholder instead of a broken image.
 */
export function Cover({
  src,
  alt = "",
  onError,
}: {
  src: string | null;
  alt?: string;
  onError?: () => void;
}) {
  const [broken, setBroken] = useState(false);

  // A new src is worth another load attempt after a previous one failed.
  useEffect(() => setBroken(false), [src]);

  const showArt = src != null && !broken;

  return (
    <div className={styles.cover}>
      {showArt ? (
        <img
          className={styles.art}
          src={src}
          alt={alt}
          onError={() => {
            setBroken(true);
            onError?.();
          }}
        />
      ) : (
        <span className={styles.placeholder} aria-hidden="true">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="9" cy="10" r="2" />
            <path d="m4 18 5-4 4 3 3-2 4 3" />
          </svg>
        </span>
      )}
      <span className={styles.grain} aria-hidden="true" />
    </div>
  );
}
