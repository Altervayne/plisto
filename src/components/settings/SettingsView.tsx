// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { FolderRow } from "./FolderRow";

// -- State Imports --
import {
  useAddRoot,
  useLoadRoots,
  useRescanAll,
  useRoots,
  useScanStatus,
} from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";

/**
 * The settings screen: a full-region folder list on the continuous surface, twinning Export's place in
 * the region but left-aligned and titled rather than centered. Each root is a quiet row - name, dimmed
 * path, count, hover-revealed rescan/remove. Add folder is the one solid accent; rescan-all is the
 * general refresh. A rescan reloads only the tracks, so both rescans reload the roots to keep the
 * per-root counts true.
 */
export function SettingsView() {
  const roots = useRoots();
  const addRoot = useAddRoot();
  const rescanAll = useRescanAll();
  const loadRoots = useLoadRoots();
  const scanning = useScanStatus() === "scanning";
  const t = useT();

  const onRescanAll = async () => {
    await rescanAll();
    await loadRoots();
  };

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <h1 className={styles.title}>{t((d) => d.settings.title)}</h1>
        <p className={styles.sub}>{t((d) => d.settings.sub)}</p>
      </div>

      <ScrollArea className={styles.scroll} contentClassName={styles.list}>
        {roots.length > 0 ? (
          roots.map((root) => <FolderRow key={root.id} root={root} />)
        ) : (
          <p className={styles.empty}>{t((d) => d.settings.empty)}</p>
        )}
      </ScrollArea>

      <div className={styles.foot}>
        <PrimaryButton onClick={() => void addRoot()} disabled={scanning}>
          {t((d) => d.settings.addFolder)}
        </PrimaryButton>
        <QuietButton onClick={() => void onRescanAll()} disabled={scanning}>
          {t((d) => d.settings.rescanAll)}
        </QuietButton>
      </div>
    </div>
  );
}
