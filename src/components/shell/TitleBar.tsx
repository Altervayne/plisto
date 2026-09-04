// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { useLibraryLabel } from "../../state/store";

// -- Window Imports --
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from "../../lib/appWindow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Component Imports --
import { PlistoLogo } from "../common/PlistoLogo";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Icon Imports --
import { Minus, Square, Copy, X } from "lucide-react";

// -- Style Imports --
import styles from "./TitleBar.module.css";

/** The trailing folder of a path, so the indicator reads as a name rather than a full mono path. */
function folderName(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop();
  return leaf ?? path;
}

/**
 * The custom window chrome that replaces the native title bar: the brand and the active workspace
 * path on the left, a drag region filling the middle, and the minimize / maximize / close controls
 * on the right. Ambient ground, no divider - it parts from the content by space. The window calls
 * are guarded so the bar still renders outside the desktop shell.
 *
 * Compact mode is the standalone player's bar: no workspace to name, so the label slot carries the
 * "Open library" affordance instead, and the maximize control is dropped since maximizing a small
 * player is meaningless. Minimize and close stay.
 */
export function TitleBar({
  compact = false,
  onOpenLibrary,
}: {
  compact?: boolean;
  onOpenLibrary?: () => void;
}) {
  const label = useLibraryLabel();
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  // Reflect the maximized state on the control glyph: read once on mount, then follow every resize.
  // Outside the desktop shell both calls no-op and the state stays at its normal-size default.
  useEffect(() => {
    let alive = true;
    let unlisten: () => void = () => {};
    const sync = () => {
      void isWindowMaximized().then((v) => {
        if (alive) setMaximized(v);
      });
    };
    sync();
    void onWindowResized(sync).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten();
    };
  }, []);

  return (
    <div className={styles.bar} data-tauri-drag-region>
      <div className={styles.brand}>
        <PlistoLogo height={32} />
        <span className={styles.name}>Plisto</span>
      </div>

      {compact ? (
        // The honest spot for the escape: where the library name sits in the full app. Kept literally
        // "Open library" even with no library yet - it routes through the gate, which shows the picker
        // on a fresh install.
        <div className={styles.workspace}>
          <QuietButton onClick={onOpenLibrary}>{t((d) => d.window.openLibrary)}</QuietButton>
        </div>
      ) : label ? (
        <Tooltip label={label.kind === "single" ? label.path : undefined}>
          <div className={styles.workspace}>
            <span className={styles.dot} aria-hidden="true" />
            {/* One root reads as its folder name (full path on hover); several as a plain count. */}
            <span className={styles.path}>
              {label.kind === "single"
                ? folderName(label.path)
                : t((d) => d.window.folders, { n: label.count })}
            </span>
          </div>
        </Tooltip>
      ) : null}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          onClick={minimizeWindow}
          aria-label={t((d) => d.window.minimize)}
        >
          <Minus size={16} strokeWidth={1.3} />
        </button>
        {compact ? null : (
          <button
            type="button"
            className={styles.control}
            onClick={toggleMaximizeWindow}
            aria-label={maximized ? t((d) => d.window.restore) : t((d) => d.window.maximize)}
          >
            {maximized ? (
              <Copy size={16} strokeWidth={1.3} />
            ) : (
              <Square size={16} strokeWidth={1.3} />
            )}
          </button>
        )}
        <button
          type="button"
          className={`${styles.control} ${styles.close}`}
          onClick={closeWindow}
          aria-label={t((d) => d.window.close)}
        >
          <X size={16} strokeWidth={1.3} />
        </button>
      </div>
    </div>
  );
}
