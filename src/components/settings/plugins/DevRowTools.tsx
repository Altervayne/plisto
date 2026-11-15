// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./PluginRow.module.css";

/**
 * The developer-mode tools under a row's status line: Reload from source, offered only for a plugin that
 * remembers where it was installed from, and Open log.
 */
export function DevRowTools({
  canReload,
  busy,
  onReload,
  onOpenLog,
}: {
  canReload: boolean;
  busy: boolean;
  onReload: () => void;
  onOpenLog: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.devTools}>
      {canReload ? (
        <QuietButton onClick={onReload} disabled={busy}>
          {t((d) => d.plugins.devMode.reload)}
        </QuietButton>
      ) : null}
      <QuietButton onClick={onOpenLog}>{t((d) => d.plugins.devMode.openLog)}</QuietButton>
    </div>
  );
}
