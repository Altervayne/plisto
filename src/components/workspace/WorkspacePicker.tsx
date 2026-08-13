// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PrimaryButton } from "../common/PrimaryButton";

// -- State Imports --
import { usePickAndScan, useWorkspace } from "../../state/store";

// -- Style Imports --
import styles from "./WorkspacePicker.module.css";

/** The starting view: prompts for a music folder. The single accent is the Choose-folder button. */
export function WorkspacePicker() {
  const pickAndScan = usePickAndScan();
  const workspace = useWorkspace();

  return (
    <CenteredStage>
      <div className={styles.body}>
        <h1 className={styles.title}>Choose your music folder</h1>
        <p className={styles.safety}>
          Your files are read only. Plisto never moves, renames, or changes them.
        </p>
        <div className={styles.action}>
          <PrimaryButton onClick={() => void pickAndScan()}>
            Choose folder...
          </PrimaryButton>
        </div>
        {workspace ? <p className={styles.path}>{workspace}</p> : null}
      </div>
    </CenteredStage>
  );
}
