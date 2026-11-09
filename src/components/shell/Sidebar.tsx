// -- Component Imports --
import { NavItem } from "./NavItem";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { MiniPlayer } from "../player/MiniPlayer";
import { AppModeSwitch } from "../player/AppModeSwitch";

// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Icon Imports --
import { Home, LayoutGrid, Inbox, Library, ListMusic, Radio, History, Images, AudioLines, Download, Settings } from "lucide-react";

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
 * The sidebar: Home pinned on top, three labeled sections - Files, Library, Utilities - scrolling in the
 * middle, and the mini-player and Settings pinned to the bottom. Transparent ground, so it flows into the
 * main region with no divider. Brand and library identity live in the title bar; folder actions live in
 * Settings.
 *
 * `collapsed` clips and fades the whole rail as the shell closes its column. `bare` drops the nav
 * sections when the revealed sidebar has no library to list, leaving only the foot. The app mode shapes
 * what remains: Player drops the file and utility sections, Organizer drops the Player and History rows,
 * and a section whose rows all go takes its label with it. The foot always shows. The Collection row
 * carries no count: its segment switch carries them.
 */
export function Sidebar({
  mode,
  onModeChange,
  filesCount,
  unsortedCount,
  playlistsCount,
  coversCount,
  collapsed = false,
  bare = false,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  filesCount: number;
  unsortedCount: number;
  playlistsCount: number;
  coversCount: number;
  collapsed?: boolean;
  bare?: boolean;
}) {
  const t = useT();
  const appMode = useAppMode();
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Keep the active row in view when the destination changes by click, shortcut, or the finder.
  useEffect(() => {
    const active = viewportRef.current?.querySelector('[aria-current="page"]');
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    active?.scrollIntoView({ block: "nearest", behavior: reduced ? "instant" : "smooth" });
  }, [mode]);

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

          <ScrollArea
            className={styles.scroll}
            contentClassName={styles.scrollContent}
            viewportRef={viewportRef}
            edgeFade
          >
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
                {isDestinationVisible(appMode, "collection") ? (
                  <NavItem
                    icon={<Library size={17} strokeWidth={1.8} />}
                    label={t((d) => d.nav.collection)}
                    active={mode === "collection"}
                    onClick={() => onModeChange("collection")}
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
          </ScrollArea>
        </>
      )}

      {/* Without the scroll area to take the free space, the spacer keeps the foot at the bottom. */}
      {bare ? <div className={styles.spacer} /> : null}

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
