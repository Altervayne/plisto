// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- IPC Imports --
import { exportTemplatePreview } from "../../lib/ipc";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Local Imports --
import { EXPORT_PRESETS } from "./templates";

// -- Type Imports --
import type { ExportPreset, PresetId } from "./templates";

// -- Style Imports --
import styles from "./ExportView.module.css";

/** How long typing settles before a custom pattern commits, so the preview refetches once per pause. */
const COMMIT_DELAY = 250;

/**
 * The layout section: a quiet preset picker over the album patterns, a Custom pair of fields when it is
 * chosen, and a live example path under both. The selection carries accent linework only - the Export
 * CTA keeps the sole solid accent. The example renders through the backend derivation, so it matches
 * exactly what a run would write.
 */
export function ExportLayout({
  folder,
  file,
  selected,
  onSelectPreset,
  onSelectCustom,
  onCustomPatterns,
}: {
  folder: string;
  file: string;
  selected: PresetId | "custom";
  onSelectPreset: (preset: ExportPreset) => void;
  onSelectCustom: () => void;
  onCustomPatterns: (folder: string, file: string) => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<string | null>(null);

  // The example tracks the effective patterns: a preset select moves them at once, a custom edit after
  // its debounce, so a single effect keyed on the pair refetches for both.
  useEffect(() => {
    let live = true;
    void exportTemplatePreview(folder, file)
      .then((path) => {
        if (live) setPreview(path);
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [folder, file]);

  return (
    <div className={styles.layout}>
      <div className={styles.presets} role="radiogroup" aria-label={t((d) => d.export.layout)}>
        {EXPORT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={selected === preset.id}
            className={`${styles.preset} ${selected === preset.id ? styles.presetActive : ""}`}
            onClick={() => onSelectPreset(preset)}
          >
            {t((d) => d.export.preset[preset.id])}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={selected === "custom"}
          className={`${styles.preset} ${selected === "custom" ? styles.presetActive : ""}`}
          onClick={onSelectCustom}
        >
          {t((d) => d.export.preset.custom)}
        </button>
      </div>

      {selected === "custom" ? (
        <CustomPatternFields folder={folder} file={file} onCommit={onCustomPatterns} />
      ) : null}

      {preview ? (
        <p className={styles.preview}>{t((d) => d.export.example, { path: preview })}</p>
      ) : null}
    </div>
  );
}

/**
 * The Custom pair: two token fields seeded from the current patterns, committing on a debounce so the
 * preview and persistence settle after a pause rather than per keystroke. Mounted only while Custom is
 * the selection, so it reseeds from whatever preset the user left each time Custom is re-entered.
 */
function CustomPatternFields({
  folder,
  file,
  onCommit,
}: {
  folder: string;
  file: string;
  onCommit: (folder: string, file: string) => void;
}) {
  const t = useT();
  const [draftFolder, setDraftFolder] = useState(folder);
  const [draftFile, setDraftFile] = useState(file);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback(
    (nextFolder: string, nextFile: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onCommit(nextFolder, nextFile), COMMIT_DELAY);
    },
    [onCommit],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className={styles.customFields}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t((d) => d.export.folderPattern)}</span>
        <input
          type="text"
          className={styles.input}
          value={draftFolder}
          spellCheck={false}
          onChange={(e) => {
            setDraftFolder(e.target.value);
            schedule(e.target.value, draftFile);
          }}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t((d) => d.export.filePattern)}</span>
        <input
          type="text"
          className={styles.input}
          value={draftFile}
          spellCheck={false}
          onChange={(e) => {
            setDraftFile(e.target.value);
            schedule(draftFolder, e.target.value);
          }}
        />
      </label>
      <p className={styles.tokens}>{t((d) => d.export.tokens)}</p>
    </div>
  );
}
