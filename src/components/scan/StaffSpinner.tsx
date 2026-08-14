// -- Framework Imports --
import type { CSSProperties } from "react";

// -- Style Imports --
import styles from "./StaffSpinner.module.css";

/** The five staff lines, top to bottom. */
const STAFF = [8, 15, 22, 29, 36];

/** Note positions along the staff - varied pitches read as a little melody as they light up in turn. */
const NOTES = [
  { x: 28, y: 29 },
  { x: 48, y: 19 },
  { x: 68, y: 25 },
  { x: 88, y: 15 },
  { x: 108, y: 22 },
];

/**
 * The scanning spinner: a music staff whose notes light up one by one, then clear and loop - a bespoke
 * indeterminate motion for the indexing pass. Reduced-motion holds the notes lit.
 */
export function StaffSpinner() {
  return (
    <svg className={styles.spinner} viewBox="0 0 132 44" fill="none" aria-hidden="true">
      <g className={styles.staff}>
        {STAFF.map((y) => (
          <line key={y} x1="6" y1={y} x2="126" y2={y} />
        ))}
      </g>
      {NOTES.map((n, i) => (
        <g
          key={i}
          className={styles.note}
          style={
            {
              animationDelay: `${i * 0.18}s`,
              transformOrigin: `${n.x}px ${n.y}px`,
            } as CSSProperties
          }
        >
          <ellipse cx={n.x} cy={n.y} rx="4.4" ry="3.1" transform={`rotate(-20 ${n.x} ${n.y})`} />
          <line x1={n.x + 3.9} y1={n.y - 1.2} x2={n.x + 3.9} y2={n.y - 15} />
        </g>
      ))}
    </svg>
  );
}
