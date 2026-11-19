// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { Switch } from "../common/Switch/Switch";
import { FolderRow } from "./FolderRow";
import { GenreAddRow } from "./GenreAddRow";
import { GenreSettingRow } from "./GenreSettingRow";
import { PlaybackDeviceRow } from "./PlaybackDeviceRow";
import { PlayHistoryRow } from "./PlayHistoryRow";
import { SearchSettingsDoor } from "./SearchSettingsDoor";
import { SettingRow } from "./SettingRow";
import { SectionsMenu, SettingsRail } from "./SettingsRail";
import { PluginsSection } from "./plugins/PluginsSection";
import { SoundSection } from "./SoundSection";
import { VisualizersSection } from "./visualizers/VisualizersSection";
import { UpdatesSection } from "./UpdatesSection";
import { ScanSummaryLine } from "../tracks/ScanSummaryLine";
import { ProgressLine } from "../scan/ProgressLine";
import { ScanIssuesRow, issuesRowState } from "./ScanIssuesRow";
import { isWindowsPlatform } from "./settingsRegistry";
import { SETTINGS_SECTIONS, sectionAttr } from "./settingsSections";
import { useSettingsNav } from "./useSettingsNav";

// -- State Imports --
import {
  useAddRoot,
  useBlockingScan,
  useCancelScan,
  useQuietCheckFailed,
  useRescanQuiet,
  useRoots,
  useScanMode,
  useScanProgress,
  useScanStatus,
  useScanSummary,
  useSetLibraryGone,
} from "../../state/store";
import { useGenres, useLoadGenres } from "../../state/organize/store";
import { useOpenScanIssues, useScanIssuesStore } from "../../state/scanIssues";
import {
  useCloseToTray,
  useKeepLibraryUpToDate,
  useSetCloseToTray,
  useSetKeepLibraryUpToDate,
} from "../../state/preferences/store";
import { useSetShortcutsOpen } from "../../state/shell/store";

// -- IPC Imports --
import { openDefaultAppsSettings } from "../../lib/ipc";

// -- Theme Imports --
import { useTheme, useSetTheme } from "../../theme";

// -- i18n Imports --
import { useT, useLocale, useSetLocale } from "../../i18n";

// -- Type Imports --
import type { Segment } from "../common/SegmentedControl";
import type { SettingsSectionId } from "./settingsSections";
import type { ThemeChoice } from "../../theme";
import type { Locale } from "../../i18n/types";

// -- Style Imports --
import styles from "./SettingsView.module.css";

/**
 * One section's page. Every page stays mounted so a switch loses no state and refetches nothing; the
 * ones not on show are `hidden`, which takes them out of layout, tab order and the accessibility tree.
 */
function Page({ id, shown, children }: { id: SettingsSectionId; shown: SettingsSectionId; children: ReactNode }) {
  const t = useT();
  const section = SETTINGS_SECTIONS.find((s) => s.id === id);
  return (
    <div role="region" aria-label={section ? t(section.label) : undefined} hidden={id !== shown}>
      {children}
    </div>
  );
}

/**
 * The settings screen: one section at a time in a capped reading column, flush left under the title - no
 * frames, no cards, parted only by space and a dimmed micro-label. Each preference groups its row with
 * its helper; a control sits trailing and wraps under its label when the column narrows. A rail beside
 * the column picks the section when the window is wide enough and folds into a Sections button in the
 * head when it is not; a target another surface asked for opens its section and is landed on and marked
 * here. Folders holds the library roots and their actions. Rescans run quiet, as does the background
 * sync: while a quiet scan runs its progress and a Cancel sit under the buttons, which stay live since a
 * request joins it and adding a folder preempts it. A failed check leaves a warn line there. Otherwise
 * the last summary sits under the buttons; when it left files gone from disk, its Review link opens All
 * Tracks filtered to them through `onReviewGone`. Files a scan could not read add a standing row under
 * it with the count on record and a Review button for the sheet. The keep-up-to-date switch closes the
 * section.
 */
export function SettingsView({
  onReviewGone,
  onSearchSettings,
}: {
  onReviewGone?: () => void;
  onSearchSettings?: (door: HTMLElement) => void;
}) {
  const roots = useRoots();
  const addRoot = useAddRoot();
  const rescanQuiet = useRescanQuiet();
  const cancelScan = useCancelScan();
  const scanning = useScanStatus() === "scanning";
  const quiet = useScanMode() === "quiet";
  const blocking = useBlockingScan();
  const progress = useScanProgress();
  const checkFailed = useQuietCheckFailed();
  const scanSummary = useScanSummary();
  const setGone = useSetLibraryGone();
  const genres = useGenres();
  const loadGenres = useLoadGenres();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const locale = useLocale();
  const setLocale = useSetLocale();
  const closeToTray = useCloseToTray();
  const setCloseToTray = useSetCloseToTray();
  const keepUpToDate = useKeepLibraryUpToDate();
  const setKeepUpToDate = useSetKeepLibraryUpToDate();
  const setShortcutsOpen = useSetShortcutsOpen();
  const issueCount = useScanIssuesStore((s) => s.count);
  const issueStatus = useScanIssuesStore((s) => s.countStatus);
  const refreshIssueCount = useScanIssuesStore((s) => s.refreshCount);
  const openIssues = useOpenScanIssues();
  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { section, pick } = useSettingsNav(viewportRef);

  // Settings can open before Organize ever loads, so pull the vocabulary in on mount.
  useEffect(() => {
    void loadGenres();
  }, [loadGenres]);

  // The standing unreadable count is read on mount and again whenever a scan lands a new summary.
  useEffect(() => {
    void refreshIssueCount();
  }, [refreshIssueCount, scanSummary]);

  // Review opens All Tracks already narrowed to the gone tracks, the chip naming why; it never purges,
  // it only surfaces them for the user to act on there.
  const onReviewGoneTracks = () => {
    setGone(true);
    onReviewGone?.();
  };

  const themeSegments: Segment<ThemeChoice>[] = [
    { value: "system", label: t((d) => d.settings.themeSystem) },
    { value: "light", label: t((d) => d.settings.themeLight) },
    { value: "dark", label: t((d) => d.settings.themeDark) },
  ];

  // The language names read in their own tongue, so they are literals rather than translated leaves.
  const localeSegments: Segment<Locale>[] = [
    { value: "en", label: "English" },
    { value: "fr", label: "Français" },
  ];

  // The two close behaviors, mapped to a boolean pref: "tray" keeps it alive, "quit" exits.
  const closeSegments: Segment<"quit" | "tray">[] = [
    { value: "quit", label: t((d) => d.settings.closeQuit) },
    { value: "tray", label: t((d) => d.settings.closeTray) },
  ];

  // The make-default row is a Windows-only affordance - only Windows has the Default apps page it
  // opens - so it stays hidden elsewhere rather than offering a control that does nothing.
  const isWindows = isWindowsPlatform();

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{t((d) => d.settings.title)}</h1>
          <p className={styles.sub}>{t((d) => d.settings.sub)}</p>
        </div>
        <div className={styles.headActs}>
          {onSearchSettings ? (
            <SearchSettingsDoor onOpen={onSearchSettings} />
          ) : null}
          <SectionsMenu active={section} onPick={pick} />
        </div>
      </div>

      <div className={styles.body}>
        <SettingsRail active={section} onPick={pick} />
        <ScrollArea
          className={styles.scroll}
          contentClassName={styles.sections}
          viewportRef={viewportRef}
        >
          <Page id="folders" shown={section}>
            <section className={styles.section} {...sectionAttr("folders")}>
              <h2 className={styles.label}>{t((d) => d.settings.sectionFolders)}</h2>
              <div className={styles.list}>
                {roots.length > 0 ? (
                  roots.map((root) => <FolderRow key={root.id} root={root} />)
                ) : (
                  <p className={styles.empty}>{t((d) => d.settings.empty)}</p>
                )}
              </div>
              <div className={styles.foot}>
                <SettingRow id="addFolder" className={styles.control}>
                  <PrimaryButton onClick={() => void addRoot()} disabled={blocking}>
                    {t((d) => d.settings.addFolder)}
                  </PrimaryButton>
                </SettingRow>
                <SettingRow id="rescanAll" className={styles.control}>
                  <QuietButton onClick={() => void rescanQuiet()} disabled={blocking}>
                    {t((d) => d.settings.rescanAll)}
                  </QuietButton>
                </SettingRow>
              </div>
              {scanning && quiet ? (
                <div className={styles.scanRow}>
                  <ProgressLine
                    value={progress && progress.total > 0 ? progress.scanned / progress.total : null}
                  />
                  <QuietButton onClick={() => void cancelScan()}>{t((d) => d.common.cancel)}</QuietButton>
                </div>
              ) : (
                <>
                  {checkFailed ? (
                    <p className={styles.scanFailed}>{t((d) => d.window.checkFailed)}</p>
                  ) : null}
                  {scanSummary || issuesRowState(issueCount, issueStatus) !== "hidden" ? (
                    <div className={styles.pref}>
                      {scanSummary ? (
                        <ScanSummaryLine summary={scanSummary} onReview={onReviewGoneTracks} />
                      ) : null}
                      <ScanIssuesRow
                        count={issueCount}
                        status={issueStatus}
                        onReview={openIssues}
                        onRetry={() => void refreshIssueCount()}
                      />
                    </div>
                  ) : null}
                </>
              )}
              <SettingRow id="keepUpToDate" className={`${styles.pref} ${styles.keepPref}`}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t((d) => d.settings.keepUpToDate)}</span>
                  <span className={styles.control}>
                    <Switch
                      checked={keepUpToDate}
                      onChange={setKeepUpToDate}
                      label={t((d) => d.settings.keepUpToDate)}
                    />
                  </span>
                </div>
                <p className={styles.helper}>{t((d) => d.settings.keepUpToDateHelper)}</p>
              </SettingRow>
            </section>
          </Page>

          <Page id="genres" shown={section}>
            <section className={styles.section} {...sectionAttr("genres")}>
              <h2 className={styles.label}>{t((d) => d.settings.sectionGenres)}</h2>
              <div className={styles.list}>
                {genres.length > 0 ? (
                  genres.map((genre) => (
                    <GenreSettingRow key={genre.id} genre={genre} genres={genres} />
                  ))
                ) : (
                  <p className={styles.empty}>{t((d) => d.settings.genresEmpty)}</p>
                )}
              </div>
              <div className={styles.foot}>
                <GenreAddRow className={styles.genreAdd} />
              </div>
            </section>
          </Page>

          <Page id="playback" shown={section}>
            <section className={styles.section} {...sectionAttr("playback")}>
              <h2 className={styles.label}>{t((d) => d.settings.sectionPlayback)}</h2>
              <SettingRow id="outputDevice" className={styles.pref}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t((d) => d.settings.outputDevice)}</span>
                  <span className={`${styles.control} ${styles.controlSelect}`}>
                    <PlaybackDeviceRow />
                  </span>
                </div>
              </SettingRow>
              <PlayHistoryRow />
            </section>
          </Page>

          <Page id="sound" shown={section}>
            <SoundSection />
          </Page>

          <Page id="visualizers" shown={section}>
            <VisualizersSection />
          </Page>

          <Page id="appearance" shown={section}>
            <section className={styles.section} {...sectionAttr("appearance")}>
              <h2 className={styles.label}>{t((d) => d.settings.sectionAppearance)}</h2>
              <SettingRow id="theme" className={styles.pref}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t((d) => d.settings.theme)}</span>
                  <span className={styles.control}>
                    <SegmentedControl
                      segments={themeSegments}
                      value={theme}
                      onChange={setTheme}
                      label={t((d) => d.settings.theme)}
                    />
                  </span>
                </div>
              </SettingRow>
              <SettingRow id="language" className={styles.pref}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t((d) => d.settings.language)}</span>
                  <span className={styles.control}>
                    <SegmentedControl
                      segments={localeSegments}
                      value={locale}
                      onChange={setLocale}
                      label={t((d) => d.settings.language)}
                    />
                  </span>
                </div>
              </SettingRow>
            </section>
          </Page>

          <Page id="system" shown={section}>
            <section className={styles.section} {...sectionAttr("system")}>
              <h2 className={styles.label}>{t((d) => d.settings.sectionSystem)}</h2>
              <SettingRow id="closeBehavior" className={styles.pref}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t((d) => d.settings.closeBehavior)}</span>
                  <span className={styles.control}>
                    <SegmentedControl
                      segments={closeSegments}
                      value={closeToTray ? "tray" : "quit"}
                      onChange={(value) => setCloseToTray(value === "tray")}
                      label={t((d) => d.settings.closeBehavior)}
                    />
                  </span>
                </div>
                <p className={styles.helper}>{t((d) => d.settings.closeHelper)}</p>
              </SettingRow>
              {isWindows ? (
                <SettingRow id="defaultApp" className={styles.pref}>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>{t((d) => d.settings.defaultApp)}</span>
                    <span className={`${styles.control} ${styles.controlQuiet}`}>
                      <QuietButton onClick={() => void openDefaultAppsSettings().catch(() => {})}>
                        {t((d) => d.settings.makeDefault)}
                      </QuietButton>
                    </span>
                  </div>
                  <p className={styles.helper}>{t((d) => d.settings.makeDefaultHelper)}</p>
                </SettingRow>
              ) : null}
              <SettingRow id="shortcuts" className={styles.pref}>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>{t((d) => d.shortcuts.title)}</span>
                  <span className={`${styles.control} ${styles.controlQuiet}`}>
                    <QuietButton onClick={() => setShortcutsOpen(true)}>
                      {t((d) => d.shortcuts.show)}
                    </QuietButton>
                  </span>
                </div>
              </SettingRow>
            </section>
          </Page>

          <Page id="plugins" shown={section}>
            <PluginsSection />
          </Page>

          <Page id="updates" shown={section}>
            <UpdatesSection />
          </Page>
        </ScrollArea>
      </div>
    </div>
  );
}
