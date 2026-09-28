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
import { LibraryStatus } from "./LibraryStatus";

// -- Icon Imports --
import { Minus, Square, Copy, X } from "lucide-react";

// -- Style Imports --
import styles from "./TitleBar.module.css";

/**
 * The custom window chrome replacing the native title bar: the brand and the library status on the
 * left, a drag region in the middle, and minimize / maximize / close on the right. Ambient ground, no
 * divider. The window calls are guarded so the bar still renders outside the desktop shell. Only the
 * bar itself carries the drag attribute, so its buttons keep their clicks.
 *
 * Player-only mode is the standalone player's bar: no workspace to name, so the label slot carries the
 * "Open library" affordance instead. Every window control stays.
 */
export function TitleBar({
  playerOnly = false,
  onOpenLibrary,
}: {
  playerOnly?: boolean;
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

      {playerOnly ? (
        // The honest spot for the escape: where the library name sits in the full app. Kept literally
        // "Open library" even with no library yet - it routes through the gate, which shows the picker
        // on a fresh install.
        <div className={styles.workspace}>
          <QuietButton onClick={onOpenLibrary}>{t((d) => d.window.openLibrary)}</QuietButton>
        </div>
      ) : label ? (
        <LibraryStatus label={label} />
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
