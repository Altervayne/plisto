// -- Framework Imports --
import { Fragment } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PlistoLogo } from "../common/PlistoLogo";
import { PrimaryButton } from "../common/PrimaryButton";

// -- Icon Imports --
import { ArrowDown, FolderPlus } from "lucide-react";

// -- State Imports --
import { useAddRoot } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./WorkspacePicker.module.css";

/**
 * The first-run welcome: a two-column composition - the large mark and greeting at the left, the three
 * steps (folders -> organize -> export) and the inviting CTA at the right. The single accent is the
 * Pick-folder button.
 */
export function WorkspacePicker() {
  const addRoot = useAddRoot();
  const t = useT();

  const steps = [t((d) => d.scan.step1), t((d) => d.scan.step2), t((d) => d.scan.step3)];

  return (
    <CenteredStage>
      <div className={styles.welcome}>
        <div className={styles.left}>
          <PlistoLogo height={156} />
          <h1 className={styles.title}>{t((d) => d.scan.pickerTitle)}</h1>
        </div>

        <div className={styles.right}>
          <ol className={styles.steps}>
            {steps.map((step, i) => (
              <Fragment key={i}>
                <li className={styles.step}>
                  <span className={styles.num}>{i + 1}</span>
                  <span className={styles.stepText}>{step}</span>
                </li>
                {i < steps.length - 1 ? (
                  <ArrowDown
                    className={styles.arrow}
                    size={16}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                ) : null}
              </Fragment>
            ))}
          </ol>

          <div className={styles.action}>
            <PrimaryButton cta block onClick={() => void addRoot()}>
              <FolderPlus size={18} strokeWidth={1.9} aria-hidden="true" />
              {t((d) => d.scan.chooseFolder)}
            </PrimaryButton>
          </div>

          <p className={styles.safety}>{t((d) => d.scan.pickerSafety)}</p>
        </div>
      </div>
    </CenteredStage>
  );
}
