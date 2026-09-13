// -- Component Imports --
import { NavItem } from "./NavItem";
import { MiniPlayer } from "../player/MiniPlayer";
import { AppModeSwitch } from "../player/AppModeSwitch";

// -- Icon Imports --
import { Home, LayoutGrid, Inbox, Library, Disc, Disc3, ListMusic, Radio, History, Images, AudioLines, Download, Settings } from "lucide-react";

// -- State Imports --
import { useAppMode } from "../../state/player/store";

// -- Unit Imports --
import { NAV_SECTIONS, isDestinationVisible, isSectionVisible } from "./navVisibility";
import type { Mode } from "./navVisibility";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Sidebar.module.css";

/**
 * The sidebar: three labeled sections - Files, Library, Utilities - over the mini-player and Settings
 * pinned to the bottom past the spacer. Transparent ground, so it flows into the main region with no
 * divider. Brand and library identity live in the title bar; folder actions live in Settings.
 *
 * `collapsed` clips and fades the whole rail as the shell closes its column. `bare` drops the nav
 * sections when the revealed sidebar has no library to list, leaving only the foot. The app mode shapes
 * what remains: Player drops the file and utility sections, Organizer drops the all-tracks and player
 * rows, and a section whose rows all go takes its label with it. The foot always shows.
 */
export function Sidebar({
  mode,
  onModeChange,
  filesCount,
  tracksCount,
  unsortedCount,
  albumsCount,
  singlesCount,
  playlistsCount,
  coversCount,
  collapsed = false,
  bare = false,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  filesCount: number;
  tracksCount: number;
  unsortedCount: number;
  albumsCount: number;
  singlesCount: number;
  playlistsCount: number;
  coversCount: number;
  collapsed?: boolean;
  bare?: boolean;
}) {
  const t = useT();
  const appMode = useAppMode();

  return (
    <aside
      className={collapsed ? `${styles.side} ${styles.collapsed}` : styles.side}
      inert={collapsed || undefined}
    >
      {bare ? null : (
        <>
          {/* Home tops the rail above the sections: the landing every mode shares, so it stands apart
              from the mode-shaped groups below and carries no count. */}
          <NavItem
            icon={<Home size={17} strokeWidth={1.8} />}
            label={t((d) => d.nav.home)}
            active={mode === "home"}
            onClick={() => onModeChange("home")}
          />

          {isSectionVisible(appMode, NAV_SECTIONS.files) ? (
            <div className={styles.navgroup}>
              <div className={styles.navlabel}>{t((d) => d.nav.filesGroup)}</div>
              {isDestinationVisible(appMode, "files") ? (
                <NavItem
                  icon={<LayoutGrid size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.files)}
                  count={filesCount}
                  active={mode === "files"}
                  onClick={() => onModeChange("files")}
                />
              ) : null}
              {isDestinationVisible(appMode, "unsorted") ? (
                <NavItem
                  icon={<Inbox size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.unsorted)}
                  count={unsortedCount}
                  active={mode === "unsorted"}
                  onClick={() => onModeChange("unsorted")}
                />
              ) : null}
              {isDestinationVisible(appMode, "covers") ? (
                <NavItem
                  icon={<Images size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.covers)}
                  count={coversCount}
                  active={mode === "covers"}
                  onClick={() => onModeChange("covers")}
                />
              ) : null}
            </div>
          ) : null}

          {isSectionVisible(appMode, NAV_SECTIONS.library) ? (
            <div className={styles.navgroup}>
              <div className={styles.navlabel}>{t((d) => d.nav.library)}</div>
              {isDestinationVisible(appMode, "tracks") ? (
                <NavItem
                  icon={<Library size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.tracks)}
                  count={tracksCount}
                  active={mode === "tracks"}
                  onClick={() => onModeChange("tracks")}
                />
              ) : null}
              {isDestinationVisible(appMode, "albums") ? (
                <NavItem
                  icon={<Disc size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.albums)}
                  count={albumsCount}
                  active={mode === "albums"}
                  onClick={() => onModeChange("albums")}
                />
              ) : null}
              {isDestinationVisible(appMode, "singles") ? (
                <NavItem
                  icon={<Disc3 size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.singles)}
                  count={singlesCount}
                  active={mode === "singles"}
                  onClick={() => onModeChange("singles")}
                />
              ) : null}
              {isDestinationVisible(appMode, "playlists") ? (
                <NavItem
                  icon={<ListMusic size={17} strokeWidth={1.8} />}
                  label={t((d) => d.playlists.nav)}
                  count={playlistsCount}
                  active={mode === "playlists"}
                  onClick={() => onModeChange("playlists")}
                />
              ) : null}
              {isDestinationVisible(appMode, "player") ? (
                <NavItem
                  icon={<Radio size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.player)}
                  active={mode === "player"}
                  onClick={() => onModeChange("player")}
                />
              ) : null}
              {isDestinationVisible(appMode, "history") ? (
                <NavItem
                  icon={<History size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.history)}
                  active={mode === "history"}
                  onClick={() => onModeChange("history")}
                />
              ) : null}
            </div>
          ) : null}

          {isSectionVisible(appMode, NAV_SECTIONS.utilities) ? (
            <div className={styles.navgroup}>
              <div className={styles.navlabel}>{t((d) => d.nav.utilities)}</div>
              {isDestinationVisible(appMode, "editor") ? (
                <NavItem
                  icon={<AudioLines size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.editor)}
                  active={mode === "editor"}
                  onClick={() => onModeChange("editor")}
                />
              ) : null}
              {isDestinationVisible(appMode, "export") ? (
                <NavItem
                  icon={<Download size={17} strokeWidth={1.8} />}
                  label={t((d) => d.nav.export)}
                  active={mode === "export"}
                  onClick={() => onModeChange("export")}
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <div className={styles.spacer} />

      {/* The now-playing mini docks here, above the pinned Settings item. It shows nothing until the
          first play, so the foot stays clean before then. */}
      <MiniPlayer onExpand={() => onModeChange("player")} />

      {/* The mode switch and Settings pair as one foot group, tight together and apart from the mini
          above. The switch is soft: Organizer only hides the play chrome, never stopping a track, so the
          mini above stays. */}
      <div className={styles.footgroup}>
        <AppModeSwitch />
        <NavItem
          icon={<Settings size={17} strokeWidth={1.8} />}
          label={t((d) => d.settings.nav)}
          active={mode === "settings"}
          onClick={() => onModeChange("settings")}
        />
      </div>
    </aside>
  );
}
