// -- Icon Imports --
import { RotateCw, Zap } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { SettingRow } from "../SettingRow";
import { FamilyBlock } from "./FamilyBlock";
import { sectionAttr } from "../settingsSections";

// -- State Imports --
import {
  PREF_KEYS,
  usePreferencesLoaded,
  useRetryPreference,
  useSetVisualizerCatalog,
  useVisualizerCatalog,
} from "../../../state/preferences/store";

// -- Hook Imports --
import { useCatalogRows } from "./useCatalogRows";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";
import styles from "./VisualizersSection.module.css";

/**
 * The Settings Visualizers section: which visualizers and families the picker, the cycle and the
 * defaults may use. While the stored choices are unread, failed or newer than this version, every switch
 * is disabled and everything stays on; an unreadable value offers a retry.
 */
export function VisualizersSection() {
  const t = useT();
  const catalog = useVisualizerCatalog();
  const setCatalog = useSetVisualizerCatalog();
  const loaded = usePreferencesLoaded();
  const retry = useRetryPreference();
  const families = useCatalogRows(catalog);
  const total = catalog.entries.length;

  return (
    <section className={settingsStyles.section} {...sectionAttr("visualizers")}>
      <h2 className={settingsStyles.label}>{t((d) => d.settings.sectionVisualizers)}</h2>

      <SettingRow id="visualizerCatalog" className={styles.intro}>
        <p className={settingsStyles.helper}>{t((d) => d.settings.visualizersHelper)}</p>
        <p className={styles.flashLine}>
          <Zap size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>{t((d) => d.settings.visualizersFlashLine)}</span>
        </p>
        <div className={styles.status}>
          {!loaded ? (
            <span>{t((d) => d.settings.visualizersReading)}</span>
          ) : !catalog.writable ? (
            <>
              <span className={styles.warn}>{t((d) => d.settings.visualizersFailed)}</span>
              <QuietButton onClick={() => void retry(PREF_KEYS.playerVisualizerCatalog)}>
                <RotateCw size={15} strokeWidth={1.8} aria-hidden="true" />
                {t((d) => d.settings.visualizersRetry)}
              </QuietButton>
            </>
          ) : (
            <span>{t((d) => d.settings.visualizersOnCount, { n: catalog.offeredKinds.length, total })}</span>
          )}
        </div>
      </SettingRow>

      <div className={styles.families}>
        {families.map((family) => (
          <FamilyBlock key={family.id} family={family} catalog={catalog} onChange={setCatalog} />
        ))}
      </div>
    </section>
  );
}
