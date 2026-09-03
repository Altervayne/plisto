// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { GenreAdder } from "../common/GenreAdder";
import { FolderRow } from "./FolderRow";
import { GenreSettingRow } from "./GenreSettingRow";
import { PlaybackDeviceRow } from "./PlaybackDeviceRow";

// -- State Imports --
import {
  useAddRoot,
  useLoadRoots,
  useRescanAll,
  useRoots,
  useScanStatus,
} from "../../state/store";
import { useCreateGenre, useGenres, useLoadGenres } from "../../state/organize/store";
import { useCloseToTray, useSetCloseToTray } from "../../state/preferences/store";

// -- Theme Imports --
import { useTheme, useSetTheme } from "../../theme";

// -- i18n Imports --
import { useT, useLocale, useSetLocale } from "../../i18n";

// -- Type Imports --
import type { Segment } from "../common/SegmentedControl";
import type { ThemeChoice } from "../../theme";
import type { Locale } from "../../i18n/types";

// -- Style Imports --
import styles from "./SettingsView.module.css";

/**
 * The settings screen: quiet labelled sections stacked on the continuous surface - no frames, no
 * cards, parted only by space and a dimmed micro-label. Folders holds the library roots and their
 * actions; Appearance and Language each carry an accent-free segmented control bound to a persisted
 * pref. A rescan reloads only the tracks, so both rescans reload the roots to keep the counts true.
 */
export function SettingsView() {
  const roots = useRoots();
  const addRoot = useAddRoot();
  const rescanAll = useRescanAll();
  const loadRoots = useLoadRoots();
  const scanning = useScanStatus() === "scanning";
  const genres = useGenres();
  const loadGenres = useLoadGenres();
  const createGenre = useCreateGenre();
  const theme = useTheme();
  const setTheme = useSetTheme();
  const locale = useLocale();
  const setLocale = useSetLocale();
  const closeToTray = useCloseToTray();
  const setCloseToTray = useSetCloseToTray();
  const t = useT();

  // Settings can open before Organize ever loads, so pull the vocabulary in on mount.
  useEffect(() => {
    void loadGenres();
  }, [loadGenres]);

  const onRescanAll = async () => {
    await rescanAll();
    await loadRoots();
  };

  // The store surfaces any failure through its error channel; swallow the rejection here.
  const onCreateGenre = (name: string) => {
    void createGenre(name).catch(() => {});
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

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <h1 className={styles.title}>{t((d) => d.settings.title)}</h1>
        <p className={styles.sub}>{t((d) => d.settings.sub)}</p>
      </div>

      <ScrollArea className={styles.scroll} contentClassName={styles.sections}>
        <section className={styles.section}>
          <h2 className={styles.label}>{t((d) => d.settings.sectionFolders)}</h2>
          <div className={styles.list}>
            {roots.length > 0 ? (
              roots.map((root) => <FolderRow key={root.id} root={root} />)
            ) : (
              <p className={styles.empty}>{t((d) => d.settings.empty)}</p>
            )}
          </div>
          <div className={styles.foot}>
            <PrimaryButton onClick={() => void addRoot()} disabled={scanning}>
              {t((d) => d.settings.addFolder)}
            </PrimaryButton>
            <QuietButton onClick={() => void onRescanAll()} disabled={scanning}>
              {t((d) => d.settings.rescanAll)}
            </QuietButton>
          </div>
        </section>

        <section className={styles.section}>
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
            <div className={styles.genreAdd}>
              <GenreAdder
                genres={genres}
                onPick={() => {}}
                onCreate={onCreateGenre}
                placeholder={t((d) => d.settings.addGenre)}
              />
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.label}>{t((d) => d.settings.sectionPlayback)}</h2>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t((d) => d.settings.outputDevice)}</span>
            <PlaybackDeviceRow />
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.label}>{t((d) => d.settings.sectionSystem)}</h2>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t((d) => d.settings.closeBehavior)}</span>
            <SegmentedControl
              segments={closeSegments}
              value={closeToTray ? "tray" : "quit"}
              onChange={(value) => setCloseToTray(value === "tray")}
              label={t((d) => d.settings.closeBehavior)}
            />
          </div>
          <p className={styles.helper}>{t((d) => d.settings.closeHelper)}</p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.label}>{t((d) => d.settings.sectionAppearance)}</h2>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t((d) => d.settings.theme)}</span>
            <SegmentedControl
              segments={themeSegments}
              value={theme}
              onChange={setTheme}
              label={t((d) => d.settings.theme)}
            />
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.label}>{t((d) => d.settings.sectionLanguage)}</h2>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t((d) => d.settings.language)}</span>
            <SegmentedControl
              segments={localeSegments}
              value={locale}
              onChange={setLocale}
              label={t((d) => d.settings.language)}
            />
          </div>
        </section>
      </ScrollArea>
    </div>
  );
}
