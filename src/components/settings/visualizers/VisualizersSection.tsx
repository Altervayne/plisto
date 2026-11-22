// -- Icon Imports --
import { FileArchive, FolderOpen, RotateCw, Zap } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { RestartFailure } from "../../plugins/RestartFailure";
import { SettingRow } from "../SettingRow";
import { ReviewSheet } from "../plugins/ReviewSheet/ReviewSheet";
import { RowMessageLine } from "../plugins/RowMessageLine";
import { UninstallDialog } from "../plugins/UninstallDialog";
import { FamilyBlock } from "./FamilyBlock";
import { PluginFamily } from "./PluginFamily";
import { StopFlashingRow } from "./StopFlashingRow";
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
import { useFamilyOps } from "./useFamilyOps";

// -- Utils Imports --
import { pickFolder, pickPluginFile } from "../../../lib/dialog";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";
import styles from "./VisualizersSection.module.css";

/**
 * The Settings Visualizers section: which visualizers and families the picker, the cycle and the
 * defaults may use, and where visualizer plugins are added and managed: the Add visualizers row, one
 * family per plugin, and the review sheet and uninstall confirm they open. While the stored choices are
 * unread, failed or newer than this version, every switch is disabled and everything stays on; an
 * unreadable value offers a retry.
 */
export function VisualizersSection() {
  const t = useT();
  const catalog = useVisualizerCatalog();
  const setCatalog = useSetVisualizerCatalog();
  const loaded = usePreferencesLoaded();
  const retry = useRetryPreference();
  const families = useCatalogRows(catalog);
  const total = catalog.entries.length;
  const { ops, flow, actions, restart, lock, uninstalling, setUninstalling, busy } = useFamilyOps();

  const addFrom = async (pick: () => Promise<string | null>) => {
    const path = await pick();
    if (path) await flow.inspect(path);
  };

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

      <div className={styles.add}>
        <span className={styles.addLabel}>{t((d) => d.plugins.vis.addTitle)}</span>
        <QuietButton onClick={() => void addFrom(pickPluginFile)} disabled={busy}>
          <FileArchive size={15} strokeWidth={1.8} />
          {t((d) => d.plugins.vis.addFile)}
        </QuietButton>
        <QuietButton onClick={() => void addFrom(pickFolder)} disabled={busy}>
          <FolderOpen size={15} strokeWidth={1.8} />
          {t((d) => d.plugins.vis.addFolder)}
        </QuietButton>
      </div>
      {actions.message ? <RowMessageLine message={actions.message} onDismiss={actions.dismiss} /> : null}
      {restart.error ? <RestartFailure error={restart.error} onDismiss={restart.dismiss} /> : null}

      <StopFlashingRow />

      <div className={styles.families}>
        {families.map((family) =>
          family.plugin ? (
            <PluginFamily key={family.id} family={family} catalog={catalog} onChange={setCatalog} ops={ops} />
          ) : (
            <FamilyBlock key={family.id} family={family} catalog={catalog} onChange={setCatalog} />
          ),
        )}
      </div>

      {uninstalling ? (
        <UninstallDialog
          key={uninstalling.id}
          row={uninstalling}
          busy={lock.busy}
          onConfirm={(row, deleteData) => void actions.uninstall(row, deleteData)}
          onClose={() => setUninstalling(null)}
        />
      ) : null}

      {flow.sheet ? (
        <ReviewSheet
          state={flow.sheet}
          onConfirm={(ticked, clearData) => void flow.confirm(ticked, clearData)}
          onClose={flow.close}
        />
      ) : null}
    </section>
  );
}
