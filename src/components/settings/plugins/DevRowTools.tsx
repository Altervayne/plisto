// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./PluginRow.module.css";

/**
 * The developer-mode tools under a row's status line: Reload from source, offered only for a plugin that
 * remembers where it was installed from, and Open log. `plain` drops the wrapper so the buttons join the
 * button row they sit in.
 */
export function DevRowTools({
  canReload,
  busy,
  onReload,
  onOpenLog,
  plain = false,
}: {
  canReload: boolean;
  busy: boolean;
  onReload: () => void;
  onOpenLog: () => void;
  plain?: boolean;
}) {
  const t = useT();
  const buttons = (
    <>
      {canReload ? (
        <QuietButton onClick={onReload} disabled={busy}>
          {t((d) => d.plugins.devMode.reload)}
        </QuietButton>
      ) : null}
      <QuietButton onClick={onOpenLog}>{t((d) => d.plugins.devMode.openLog)}</QuietButton>
    </>
  );
  return plain ? buttons : <div className={styles.devTools}>{buttons}</div>;
}
