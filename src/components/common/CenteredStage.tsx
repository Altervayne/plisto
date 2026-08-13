// -- Framework Imports --
import type { ReactNode } from "react";

// -- Style Imports --
import styles from "./CenteredStage.module.css";

/** Centers its children vertically and horizontally on the ambient ground. */
export function CenteredStage({ children }: { children: ReactNode }) {
  return <div className={styles.stage}>{children}</div>;
}
