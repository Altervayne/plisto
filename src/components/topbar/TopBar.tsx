// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import {
  useChangeWorkspace,
  useRescan,
  useScanSummary,
  useWorkspace,
} from "../../state/store";

// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Style Imports --
import styles from "./TopBar.module.css";

/** The top area shown over the indexed library: identity, track count, path, and quiet actions. */
export function TopBar() {
  const workspace = useWorkspace();
  const summary = useScanSummary();
  const rescan = useRescan();
  const changeWorkspace = useChangeWorkspace();

  const count = summary?.total ?? 0;

  return (
    <header className={styles.bar}>
      <h1 className={styles.title}>Plisto</h1>
      <span className={`${styles.count} tabular`}>
        {formatCount(count)} {count === 1 ? "track" : "tracks"}
      </span>
      {workspace ? <span className={styles.path}>{workspace}</span> : null}
      <div className={styles.actions}>
        <QuietButton onClick={() => void rescan()}>Re-scan</QuietButton>
        <QuietButton onClick={() => void changeWorkspace()}>Change folder</QuietButton>
      </div>
    </header>
  );
}
