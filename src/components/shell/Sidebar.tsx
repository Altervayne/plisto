// -- Component Imports --
import { NavItem } from "./NavItem";
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useChangeWorkspace, useRescan, useWorkspace } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Sidebar.module.css";

/** The library mode showing in the main region: the folder tree or the album wall. */
type Mode = "files" | "albums";

/** The brand mark: a note stem over two record dots, white on the accent square. */
function BrandMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 18V6l10-2v12"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.5" cy="18" r="2.6" stroke="#fff" strokeWidth="2" />
      <circle cx="16.5" cy="16" r="2.6" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

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

/**
 * The library sidebar: brand identity, the workspace path with a live status dot, the two mode
 * switches (Files, Albums), and the workspace actions pinned to the bottom. Transparent ground -
 * it flows into the main region with no divider between them.
 */
export function Sidebar({
  mode,
  onModeChange,
  filesCount,
  albumsCount,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  filesCount: number;
  albumsCount: number;
}) {
  const workspace = useWorkspace();
  const rescan = useRescan();
  const changeWorkspace = useChangeWorkspace();
  const t = useT();

  return (
    <aside className={styles.side}>
      <div className={styles.brand}>
        <span className={styles.mark}>
          <BrandMark />
        </span>
        <span className={styles.name}>Plisto</span>
      </div>

      {workspace ? (
        <div className={styles.workspace} title={workspace}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.path}>{workspace}</span>
        </div>
      ) : null}

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
