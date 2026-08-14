// -- Component Imports --
import { NavItem } from "./NavItem";
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useChangeWorkspace, useRescan } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Sidebar.module.css";

/** The region showing in the main pane: a library wall, or the export screen. */
type Mode = "files" | "albums" | "singles" | "export";

/** The grid-of-squares icon for Files. */
function FilesIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** The concentric-circles icon for Albums. */
function AlbumsIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

/** The single-disc icon for Singles: one ring with a solid center, distinct from Albums' two rings. */
function SinglesIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The down-arrow-to-baseline icon for Export: art landing onto disk. */
function ExportIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4 v10" />
      <path d="M7 11 l5 5 l5 -5" />
      <path d="M5 20 h14" />
    </svg>
  );
}

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
          icon={<FilesIcon />}
          label={t((d) => d.nav.files)}
          count={filesCount}
          active={mode === "files"}
          onClick={() => onModeChange("files")}
        />
        <NavItem
          icon={<AlbumsIcon />}
          label={t((d) => d.nav.albums)}
          count={albumsCount}
          active={mode === "albums"}
          onClick={() => onModeChange("albums")}
        />
        <NavItem
          icon={<SinglesIcon />}
          label={t((d) => d.nav.singles)}
          count={singlesCount}
          active={mode === "singles"}
          onClick={() => onModeChange("singles")}
        />
      </div>

      <div className={styles.navgroup}>
        <div className={styles.navlabel}>{t((d) => d.nav.output)}</div>
        <NavItem
          icon={<ExportIcon />}
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
