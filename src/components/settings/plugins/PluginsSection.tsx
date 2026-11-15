// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { FileArchive, FolderOpen, FolderSearch } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { InboxList } from "./InboxList";
import { PluginRow } from "./PluginRow";
import { SafeModeEntry } from "./SafeModeEntry";
import { UninstallDialog } from "./UninstallDialog";
import { ReviewSheet } from "./ReviewSheet/ReviewSheet";
import { SettingRow } from "../SettingRow";
import { hubSettingId } from "../settingsRegistry";
import { sectionAttr } from "../settingsSections";

// -- Hook Imports --
import { useInbox } from "./useInbox";
import { useOperationLock } from "./useOperationLock";
import { useReviewFlow } from "./useReviewFlow";
import { useRowActions } from "./useRowActions";

// -- State Imports --
import { usePlugins, usePluginsStatus } from "../../../state/plugins/store";
import { useSandboxLeaking } from "../../../state/plugins/sandboxStore";
import { reloadPlugins } from "../../../state/plugins/usePluginsSync";

// -- IPC Imports --
import { pluginInboxPath } from "../../../lib/ipc";

// -- Utils Imports --
import { pickFolder, pickPluginFile } from "../../../lib/dialog";
import { openFolder } from "../../../lib/opener";
import { appVersion } from "../../../lib/updater";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { RowMessage } from "./useRowActions";
import type { PluginRow as RowData } from "../../../types";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";
import styles from "./PluginsSection.module.css";

/**
 * The Settings Plugins section: the installed plugins with their one action each, the files waiting in
 * the inbox, and the two ways to install from a file or a folder. Every route to an install, update or
 * enable goes through one review sheet and one operation at a time. A refusal from a row command shows
 * as a line under the buttons. Reads as loading, failed (with a retry) or empty before it lists.
 */
export function PluginsSection() {
  const t = useT();
  const rows = usePlugins();
  const status = usePluginsStatus();
  const leaking = useSandboxLeaking();
  const lock = useOperationLock();
  const flow = useReviewFlow(lock);
  const actions = useRowActions(lock, flow.openReview);
  const inbox = useInbox(rows);
  const [uninstalling, setUninstalling] = useState<RowData | null>(null);
  const busy = lock.busy || flow.sheet !== null;
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void appVersion().then((v) => {
      if (alive) setCurrent(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const openInbox = () =>
    void pluginInboxPath()
      .then(openFolder)
      .catch((e: unknown) => console.warn("plugin inbox path failed", e));

  const messageText = (m: RowMessage): string =>
    m.kind === "dataWarning"
      ? t((d) => d.plugins.dataWarning, { name: m.name })
      : t((d) => d.plugins.actionFailed, { name: m.name, message: t((d) => d.plugins.errors[m.error]) });

  const installFrom = async (pick: () => Promise<string | null>) => {
    const path = await pick();
    if (path) await flow.inspect(path);
  };

  return (
    <section className={settingsStyles.section} {...sectionAttr("plugins")}>
      <h2 className={settingsStyles.label}>{t((d) => d.plugins.section)}</h2>
      <p className={settingsStyles.helper}>{t((d) => d.plugins.intro)}</p>

      {leaking ? <p className={styles.leak}>{t((d) => d.plugins.sandboxLeak)}</p> : null}

      <div className={styles.group}>
        <span className={styles.sub}>{t((d) => d.plugins.installedLabel)}</span>
        <div className={settingsStyles.list}>
          {rows.map((row) => (
            <SettingRow key={row.id} id={hubSettingId(row.id)}>
              <PluginRow
                row={row}
                busy={busy}
                currentVersion={current}
                onToggle={(r, on) => void actions.setEnabled(r, on)}
                onReview={(r) => flow.openReview(r)}
                onUninstall={setUninstalling}
              />
            </SettingRow>
          ))}
          {rows.length === 0 && (status === "idle" || status === "loading") ? (
            <p className={settingsStyles.empty}>{t((d) => d.plugins.loading)}</p>
          ) : null}
          {rows.length === 0 && status === "ready" ? (
            <p className={settingsStyles.empty}>{t((d) => d.plugins.empty)}</p>
          ) : null}
        </div>
        {status === "failed" ? (
          <div className={styles.failed}>
            <span>{t((d) => d.plugins.loadFailed)}</span>
            <QuietButton onClick={() => void reloadPlugins()}>{t((d) => d.plugins.retry)}</QuietButton>
          </div>
        ) : null}
      </div>

      <InboxList
        items={inbox}
        rows={rows}
        busy={busy}
        onReview={(item) => void flow.inspect(item.path)}
      />

      <div className={styles.foot}>
        <SettingRow id="installFile" className={settingsStyles.control}>
          <QuietButton onClick={() => void installFrom(pickPluginFile)} disabled={busy}>
            <FileArchive size={15} strokeWidth={1.8} />
            {t((d) => d.plugins.installFile)}
          </QuietButton>
        </SettingRow>
        <SettingRow id="installFolder" className={settingsStyles.control}>
          <QuietButton onClick={() => void installFrom(pickFolder)} disabled={busy}>
            <FolderOpen size={15} strokeWidth={1.8} />
            {t((d) => d.plugins.installFolder)}
          </QuietButton>
        </SettingRow>
        <SettingRow id="openFolder" className={settingsStyles.control}>
          <QuietButton onClick={openInbox}>
            <FolderSearch size={15} strokeWidth={1.8} />
            {t((d) => d.plugins.openFolder)}
          </QuietButton>
        </SettingRow>
      </div>

      <SafeModeEntry />

      {actions.message ? (
        <p className={styles.message} role="status">
          <span>{messageText(actions.message)}</span>
          <button type="button" className={styles.dismiss} onClick={actions.dismiss}>
            {t((d) => d.plugins.sheet.close)}
          </button>
        </p>
      ) : null}

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
        <ReviewSheet state={flow.sheet} onConfirm={(ticked) => void flow.confirm(ticked)} onClose={flow.close} />
      ) : null}
    </section>
  );
}
