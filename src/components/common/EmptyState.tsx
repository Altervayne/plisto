// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { CenteredStage } from "./CenteredStage";

// -- Style Imports --
import styles from "./EmptyState.module.css";

/** The tone of the state's status dot: neutral, ready, or needs-attention. */
export type EmptyTone = "idle" | "good" | "warn";

/** A centered terminal state (no results, an error) with a tone dot and an optional action. */
export function EmptyState({
  tone,
  title,
  line,
  action,
}: {
  tone: EmptyTone;
  title: string;
  line: string;
  action?: ReactNode;
}) {
  return (
    <CenteredStage>
      <div className={styles.body}>
        <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.line}>{line}</p>
        {action ? <div className={styles.action}>{action}</div> : null}
      </div>
    </CenteredStage>
  );
}
