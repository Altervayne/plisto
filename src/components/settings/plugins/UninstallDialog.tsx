// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { ConfirmDialog } from "../../common/ConfirmDialog/ConfirmDialog";
import { CheckRow } from "../../plugins/CheckRow";

// -- Utils Imports --
import { formatBytes } from "../../../lib/format";
import { uninstallPrompt } from "./rowModel";

// -- Hook Imports --
import { useDataSize } from "./useDataSize";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginRow } from "../../../types";

// -- Style Imports --
import styles from "./UninstallDialog.module.css";

/**
 * The uninstall confirm: a prompt worded for the plugin's state, the data tick (off by default, so saved
 * data stays unless asked), and the line that the library and source folders are never touched. A
 * broken plugin is "removed" rather than uninstalled, since its files could not be read. Mount it per
 * row (keyed by id) so the tick starts off each time.
 */
export function UninstallDialog({
  row,
  busy,
  onConfirm,
  onClose,
}: {
  row: PluginRow;
  /** Another plugin operation is running, so a confirm would be refused: hold it off. */
  busy: boolean;
  onConfirm: (row: PluginRow, deleteData: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [deleteData, setDeleteData] = useState(false);
  const size = useDataSize(row.id);
  const noData = size.status === "ready" && size.bytes === 0;

  const name = row.manifest?.name ?? row.id;
  const prompt = uninstallPrompt(row);
  const broken = prompt === "broken";
  const text = {
    ui: t((d) => d.plugins.uninstallDialog.promptUi, { name }),
    uiOff: t((d) => d.plugins.uninstallDialog.promptUiOff, { name }),
    native: t((d) => d.plugins.uninstallDialog.promptNative, { name }),
    nativeOff: t((d) => d.plugins.uninstallDialog.promptNativeOff, { name }),
    incompatible: t((d) => d.plugins.uninstallDialog.promptIncompatible, { name }),
    broken: t((d) => d.plugins.uninstallDialog.promptBroken, { name }),
  }[prompt];

  return (
    <ConfirmDialog
      open
      destructive
      confirmDisabled={busy}
      title={
        broken
          ? t((d) => d.plugins.uninstallDialog.titleBroken, { name })
          : t((d) => d.plugins.uninstallDialog.title, { name })
      }
      prompt={text}
      confirmLabel={
        broken ? t((d) => d.plugins.uninstallDialog.confirmBroken) : t((d) => d.plugins.uninstallDialog.confirm)
      }
      cancelLabel={t((d) => d.common.cancel)}
      onConfirm={() => onConfirm(row, deleteData && !noData)}
      onClose={onClose}
    >
      {noData ? (
        <p className={styles.note}>{t((d) => d.plugins.uninstallDialog.noData)}</p>
      ) : (
        <CheckRow
          checked={deleteData}
          onChange={setDeleteData}
          label={t((d) => d.plugins.uninstallDialog.dataTick)}
          trailing={size.status === "ready" ? formatBytes(size.bytes) : undefined}
        />
      )}
      <p className={styles.note}>{t((d) => d.plugins.uninstallDialog.keepLine)}</p>
    </ConfirmDialog>
  );
}
