// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PlistoLogo } from "../common/PlistoLogo";
import { PrimaryButton } from "../common/PrimaryButton";

// -- State Imports --
import { useAddRoot } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./WorkspacePicker.module.css";

/** The first-run welcome: the mark over a warm prompt to add the first music folder. The single accent
 * is the Choose-folder button. */
export function WorkspacePicker() {
  const addRoot = useAddRoot();
  const t = useT();

  return (
    <CenteredStage>
      <div className={styles.body}>
        <PlistoLogo height={72} />
        <h1 className={styles.title}>{t((d) => d.scan.pickerTitle)}</h1>
        <p className={styles.safety}>{t((d) => d.scan.pickerSafety)}</p>
        <div className={styles.action}>
          <PrimaryButton onClick={() => void addRoot()}>
            {t((d) => d.scan.chooseFolder)}
          </PrimaryButton>
        </div>
      </div>
    </CenteredStage>
  );
}
