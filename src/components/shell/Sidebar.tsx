// -- Component Imports --
import { NavItem } from "./NavItem";
import { QuietButton } from "../common/QuietButton";

// -- Icon Imports --
import { LayoutGrid, Disc, Disc3, Download } from "lucide-react";

// -- State Imports --
import { useChangeWorkspace, useRescan } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Sidebar.module.css";

/** The region showing in the main pane: a library wall, or the export screen. */
type Mode = "files" | "albums" | "singles" | "export";

/**
 * The sidebar: the Library mode switches (Files, Albums, Singles) over an Output group (Export), with
 * the workspace actions pinned to the bottom. Transparent ground - it flows into the main region with
 * no divider between them. Brand and workspace identity now live in the window title bar.
 */
export function Sidebar({
  mode,
  onModeChange,
  filesCount,
  albumsCount,
  singlesCount,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  filesCount: number;
  albumsCount: number;
  singlesCount: number;
}) {
  const rescan = useRescan();
  const changeWorkspace = useChangeWorkspace();
  const t = useT();

  return (
    <aside className={styles.side}>
      <div className={styles.navgroup}>
        <div className={styles.navlabel}>{t((d) => d.nav.library)}</div>
        <NavItem
          icon={<LayoutGrid size={17} strokeWidth={1.8} />}
          label={t((d) => d.nav.files)}
          count={filesCount}
          active={mode === "files"}
          onClick={() => onModeChange("files")}
        />
        <NavItem
          icon={<Disc size={17} strokeWidth={1.8} />}
          label={t((d) => d.nav.albums)}
          count={albumsCount}
          active={mode === "albums"}
          onClick={() => onModeChange("albums")}
        />
        <NavItem
          icon={<Disc3 size={17} strokeWidth={1.8} />}
          label={t((d) => d.nav.singles)}
          count={singlesCount}
          active={mode === "singles"}
          onClick={() => onModeChange("singles")}
        />
      </div>

      <div className={styles.navgroup}>
        <div className={styles.navlabel}>{t((d) => d.nav.output)}</div>
        <NavItem
          icon={<Download size={17} strokeWidth={1.8} />}
          label={t((d) => d.nav.export)}
          active={mode === "export"}
          onClick={() => onModeChange("export")}
        />
      </div>

      <div className={styles.spacer} />

      <div className={styles.actions}>
        <QuietButton onClick={() => void rescan()}>{t((d) => d.common.rescan)}</QuietButton>
        <QuietButton onClick={() => void changeWorkspace()}>
          {t((d) => d.common.changeFolder)}
        </QuietButton>
      </div>
    </aside>
  );
}
