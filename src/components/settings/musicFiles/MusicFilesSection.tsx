// -- Framework Imports --
import type { ReactNode } from "react";

// -- Library Imports --
import { TriangleAlert } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { SegmentedControl } from "../../common/SegmentedControl";
import { Switch } from "../../common/Switch/Switch";
import { SettingRow } from "../SettingRow";
import { useMusicFilesStatus } from "./useMusicFilesStatus";

// -- State Imports --
import {
  TRIM_BACKUP_DAYS,
  useSetStampFiles,
  useSetTrimBackupDays,
  useSetTrimReplace,
  useStampFiles,
  useTrimBackupDays,
  useTrimReplace,
} from "../../../state/preferences/store";
import { openKeptBackups, openStampSheet } from "../../../state/fileWrites/store";
import type { TrimBackupDays } from "../../../state/preferences/store";

// -- Utils Imports --
import { formatBytes } from "../../../lib/format";
import { lastWriteWhen } from "./lastWriteWhen";
import { sectionAttr } from "../settingsSections";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Type Imports --
import type { Segment } from "../../common/SegmentedControl";

// -- Style Imports --
import pageStyles from "../SettingsView.module.css";
import styles from "./MusicFilesSection.module.css";

/** The warning under a switch: always on screen, never behind a confirm. */
function Note({ text }: { text: string }) {
  return (
    <div className={styles.note}>
      <TriangleAlert className={styles.noteIcon} size={15} strokeWidth={1.8} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** One status line with a quiet action trailing it. */
function StatLine({
  children,
  action,
  onAction,
}: {
  children: ReactNode;
  action: string | null;
  onAction: () => void;
}) {
  return (
    <div className={styles.stat}>
      <span>{children}</span>
      {action !== null ? (
        <span className={styles.statAct}>
          <QuietButton onClick={onAction}>{action}</QuietButton>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Music files section: the two opt-ins that let Plisto write to the user's files, each with its
 * warning always shown, the backup limit, and the lines that report on past writes. A status line whose
 * read failed is left out, so the section stays usable with the backend quiet. `onUndo` opens the undo
 * of a batch; without it the last-write line reports and offers no Undo.
 */
export function MusicFilesSection({ onUndo }: { onUndo?: (batchId: number) => void }) {
  const t = useT();
  const locale = useLocale();
  const stampOn = useStampFiles();
  const setStamp = useSetStampFiles();
  const trimOn = useTrimReplace();
  const setTrim = useSetTrimReplace();
  const days = useTrimBackupDays();
  const setDays = useSetTrimBackupDays();
  const { last, differ, kept } = useMusicFilesStatus(stampOn, trimOn);

  const keepLabels: Record<TrimBackupDays, string> = {
    "7": t((d) => d.fileWrites.settings.keep7),
    "30": t((d) => d.fileWrites.settings.keep30),
    never: t((d) => d.fileWrites.settings.keepNever),
  };
  const keepSegments: Segment<TrimBackupDays>[] = TRIM_BACKUP_DAYS.map((value) => ({
    value,
    label: keepLabels[value],
  }));

  const showLast = stampOn && last != null;
  const canUndo = showLast && last.kind === "stamp" && last.undoable && onUndo !== undefined;
  const keptSize = kept ? kept.reduce((sum, b) => sum + b.size, 0) : 0;

  return (
    <section className={pageStyles.section} {...sectionAttr("musicFiles")}>
      <h2 className={pageStyles.label}>{t((d) => d.fileWrites.settings.section)}</h2>
      <p className={styles.lede}>{t((d) => d.fileWrites.settings.lede)}</p>

      <SettingRow id="stampFiles" className={pageStyles.pref}>
        <div className={pageStyles.row}>
          <span className={pageStyles.rowLabel}>{t((d) => d.fileWrites.settings.stampLabel)}</span>
          <span className={pageStyles.control}>
            <Switch
              checked={stampOn}
              onChange={setStamp}
              label={t((d) => d.fileWrites.settings.stampLabel)}
            />
          </span>
        </div>
        <p className={pageStyles.helper}>{t((d) => d.fileWrites.settings.stampHelper)}</p>
        <Note text={t((d) => d.fileWrites.settings.stampNote)} />
        {stampOn && typeof differ === "number" ? (
          <StatLine
            action={differ > 0 ? t((d) => d.fileWrites.settings.review) : null}
            onAction={() => openStampSheet({ kind: "library" })}
          >
            {t((d) => d.fileWrites.settings.differLabel)} <b>{differ.toLocaleString(locale)}</b>
          </StatLine>
        ) : null}
        {stampOn && differ === undefined ? (
          <StatLine action={null} onAction={() => {}}>
            {t((d) => d.fileWrites.settings.differLabel)} {t((d) => d.fileWrites.settings.differChecking)}
          </StatLine>
        ) : null}
        {showLast ? (
          <StatLine
            action={canUndo ? t((d) => d.fileWrites.settings.undo) : null}
            onAction={() => onUndo?.(last.batchId)}
          >
            {t((d) => d.fileWrites.settings.lastWriteLabel)}{" "}
            {last.label ? (
              <>
                <b>{last.label}</b> -{" "}
              </>
            ) : null}
            {t((d) => d.fileWrites.files, { n: last.files })} -{" "}
            {lastWriteWhen(last.at, Date.now(), locale, {
              today: (time) => t((d) => d.fileWrites.settings.lastToday, { time }),
              yesterday: (time) => t((d) => d.fileWrites.settings.lastYesterday, { time }),
            })}
          </StatLine>
        ) : null}
      </SettingRow>

      <SettingRow id="trimReplace" className={pageStyles.pref}>
        <div className={pageStyles.row}>
          <span className={pageStyles.rowLabel}>{t((d) => d.fileWrites.settings.trimLabel)}</span>
          <span className={pageStyles.control}>
            <Switch
              checked={trimOn}
              onChange={setTrim}
              label={t((d) => d.fileWrites.settings.trimLabel)}
            />
          </span>
        </div>
        <p className={pageStyles.helper}>{t((d) => d.fileWrites.settings.trimHelper)}</p>
        <Note text={t((d) => d.fileWrites.settings.trimNote)} />
        {trimOn ? (
          <>
            <div className={styles.keep}>
              <div className={styles.keepRow}>
                <span className={styles.keepLabel}>{t((d) => d.fileWrites.settings.keepLabel)}</span>
                <SegmentedControl
                  segments={keepSegments}
                  value={days}
                  onChange={setDays}
                  label={t((d) => d.fileWrites.settings.keepLabel)}
                />
              </div>
              <p className={pageStyles.helper}>{t((d) => d.fileWrites.settings.keepHelper)}</p>
            </div>
            {kept !== null && kept !== undefined ? (
              <StatLine action={t((d) => d.fileWrites.settings.manage)} onAction={openKeptBackups}>
                {t((d) => d.fileWrites.settings.keptLabel)}{" "}
                <b>
                  {kept.length === 0
                    ? t((d) => d.fileWrites.settings.keptNone)
                    : t((d) => d.fileWrites.settings.keptLine, {
                        n: kept.length,
                        size: formatBytes(keptSize),
                      })}
                </b>
              </StatLine>
            ) : null}
          </>
        ) : null}
      </SettingRow>
    </section>
  );
}
