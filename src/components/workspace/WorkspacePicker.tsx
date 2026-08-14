// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PrimaryButton } from "../common/PrimaryButton";

// -- State Imports --
import { usePickAndScan, useWorkspace } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./WorkspacePicker.module.css";

/** The starting view: prompts for a music folder. The single accent is the Choose-folder button. */
export function WorkspacePicker() {
  const pickAndScan = usePickAndScan();
  const workspace = useWorkspace();
  const t = useT();

  return (
    <CenteredStage>
      <div className={styles.body}>
        <h1 className={styles.title}>{t((d) => d.scan.pickerTitle)}</h1>
        <p className={styles.safety}>{t((d) => d.scan.pickerSafety)}</p>
        <div className={styles.action}>
          <PrimaryButton onClick={() => void pickAndScan()}>
            {t((d) => d.scan.chooseFolder)}
          </PrimaryButton>
        </div>
        {workspace ? <p className={styles.path}>{workspace}</p> : null}
      </div>
    </CenteredStage>
  );
}
