// -- Component Imports --
import { NavItem } from "./NavItem";

// -- Icon Imports --
import { LayoutGrid, Inbox, Disc, Disc3, ListMusic, Download, Settings } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Sidebar.module.css";

/** The region showing in the main pane: a library wall, the export screen, or settings. */
type Mode = "files" | "unsorted" | "albums" | "singles" | "playlists" | "export" | "settings";

/**
 * The sidebar: the Library mode switches (Files, Albums, Singles) over an Output group (Export), with
 * Settings pinned to the bottom past the spacer - app-level, apart from the content nav. Transparent
 * ground - it flows into the main region with no divider between them. Brand and library identity live
 * in the window title bar; folder actions live inside Settings.
 */
export function Sidebar({
  mode,
  onModeChange,
  filesCount,
  unsortedCount,
  albumsCount,
  singlesCount,
  playlistsCount,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  filesCount: number;
  unsortedCount: number;
  albumsCount: number;
  singlesCount: number;
  playlistsCount: number;
}) {
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
          icon={<Inbox size={17} strokeWidth={1.8} />}
          label={t((d) => d.nav.unsorted)}
          count={unsortedCount}
          active={mode === "unsorted"}
          onClick={() => onModeChange("unsorted")}
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
        <NavItem
          icon={<ListMusic size={17} strokeWidth={1.8} />}
          label={t((d) => d.playlists.nav)}
          count={playlistsCount}
          active={mode === "playlists"}
          onClick={() => onModeChange("playlists")}
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

      <NavItem
        icon={<Settings size={17} strokeWidth={1.8} />}
        label={t((d) => d.settings.nav)}
        active={mode === "settings"}
        onClick={() => onModeChange("settings")}
      />
    </aside>
  );
}
