// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";

// -- Library Imports --
import { FileArchive, FolderOpen, FolderSearch } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { TextLink, WithLink } from "../../plugins/TextLink";
import { DevModeEntry } from "./DevModeEntry";
import { InboxList } from "./InboxList";
import { PluginRow } from "./PluginRow";
import { SafeModeEntry } from "./SafeModeEntry";
import { UninstallDialog } from "./UninstallDialog";
import { ReviewSheet } from "./ReviewSheet/ReviewSheet";
import { RowMessageLine } from "./RowMessageLine";
import { SettingRow } from "../SettingRow";
import { hubSettingId } from "../settingsRegistry";
import { sectionAttr } from "../settingsSections";
import { familySettingId } from "../settingsTarget";

// -- Hook Imports --
import { useInbox } from "./useInbox";
import { useOperationLock } from "./useOperationLock";
import { useReviewFlow } from "./useReviewFlow";
import { useRowActions } from "./useRowActions";

// -- State Imports --
import { useDevMode, usePlugins, usePluginsStatus } from "../../../state/plugins/store";
import { useSandboxLeaking } from "../../../state/plugins/sandboxStore";
import { reloadPlugins } from "../../../state/plugins/usePluginsSync";
import { useOpenSettings } from "../../../state/shell/store";

// -- IPC Imports --
import { pluginInboxPath } from "../../../lib/ipc";

// -- Utils Imports --
import { catalogManagedCount, firstCatalogFamily, listedRows } from "../../shell/navVisibility";
import { pickFolder, pickPluginFile } from "../../../lib/dialog";
import { openFolder } from "../../../lib/opener";
import { appVersion } from "../../../lib/updater";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginRow as RowData } from "../../../types";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";
import styles from "./PluginsSection.module.css";

/**
 * The Settings Plugins section: the installed plugins with their one action each, the files waiting in
 * the inbox, and the two ways to install from a file or a folder. Every route to an install, update or
 * enable goes through one review sheet and one operation at a time. A refusal from a row command shows
 * as a line under the buttons. Reads as loading, failed (with a retry) or empty before it lists. The foot
 * holds safe mode and the developer-mode switch, which adds the row tools and the log panel.
 */
export function PluginsSection() {
  const t = useT();
  const rows = usePlugins();
  const listed = useMemo(() => listedRows(rows), [rows]);
  const managed = catalogManagedCount(rows);
  const firstFamily = useMemo(() => firstCatalogFamily(rows), [rows]);
  const openSettings = useOpenSettings();
  const managedTarget = firstFamily ? familySettingId(firstFamily) : "visualizers";
  const status = usePluginsStatus();
  const leaking = useSandboxLeaking();
  const lock = useOperationLock();
  const flow = useReviewFlow(lock, "plugins");
  const actions = useRowActions(lock, flow.openReview);
  const inbox = useInbox(rows);
  const [uninstalling, setUninstalling] = useState<RowData | null>(null);
  const busy = lock.busy || flow.sheet !== null;
  const [current, setCurrent] = useState<string | null>(null);
  const devMode = useDevMode();
  const [logId, setLogId] = useState<string | null>(null);
  const logPanel = useRef<HTMLDivElement>(null);

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

  const openLog = (row: RowData) => {
    setLogId(row.id);
    // The panel mounts with the selection; wait a frame so there is something to scroll to.
    requestAnimationFrame(() => logPanel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

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
          {listed.map((row) => (
            <SettingRow key={row.id} id={hubSettingId(row.id)}>
              <PluginRow
                row={row}
                busy={busy}
                currentVersion={current}
                onToggle={(r, on) => void actions.setEnabled(r, on)}
                onReview={(r) => flow.openReview(r)}
                onUninstall={setUninstalling}
                dev={devMode ? { onReload: (r) => void actions.reload(r), onOpenLog: openLog } : undefined}
              />
            </SettingRow>
          ))}
          {listed.length === 0 && (status === "idle" || status === "loading") ? (
            <p className={settingsStyles.empty}>{t((d) => d.plugins.loading)}</p>
          ) : null}
          {managed > 0 ? (
            <p className={styles.managed}>
              <WithLink
                text={t((d) => d.plugins.vis.managedLine, { n: managed })}
                link={
                  <TextLink onClick={() => openSettings({ target: managedTarget })}>
                    {t((d) => d.plugins.vis.managedLink)}
                  </TextLink>
                }
              />
            </p>
          ) : null}
          {listed.length === 0 && managed === 0 && status === "ready" ? (
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

      <DevModeEntry
        on={devMode}
        disabled={busy}
        onToggle={(on) => void actions.setDevMode(on)}
        rows={rows}
        logId={logId}
        onSelectLog={setLogId}
        panelRef={logPanel}
      />

      {actions.message ? <RowMessageLine message={actions.message} onDismiss={actions.dismiss} /> : null}

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
        <ReviewSheet state={flow.sheet} onConfirm={(ticked, clearData) => void flow.confirm(ticked, clearData)} onClose={flow.close} />
      ) : null}
    </section>
  );
}
