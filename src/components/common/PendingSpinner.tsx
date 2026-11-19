// -- Component Imports --
import { CenteredStage } from "./CenteredStage";
import { StaffSpinner } from "../scan/StaffSpinner";

// -- Hook Imports --
import { useDelayedFlag } from "../../hooks/useDelayedFlag";

// -- Style Imports --
import styles from "./PendingSpinner.module.css";

/** How long a load must run before the spinner shows, so a normal launch never flashes it. */
const SPIN_DELAY_MS = 400;

/** The quiet wait for a load: an empty stage at first, then a staff spinner over one line. */
export function PendingSpinner({ title }: { title: string }) {
  const spinning = useDelayedFlag(true, SPIN_DELAY_MS);
  return (
    <CenteredStage>
      <div className={styles.loading}>
        {spinning ? (
          <>
            <StaffSpinner />
            <p className={styles.title}>{title}</p>
          </>
        ) : null}
      </div>
    </CenteredStage>
  );
}
