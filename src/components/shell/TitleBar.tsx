// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { useWorkspace } from "../../state/store";

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

// -- Style Imports --
import styles from "./TitleBar.module.css";

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

/** A single line: the minimize glyph. */
function MinimizeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="8" x2="12" y2="8" />
    </svg>
  );
}

/** A single square: the maximize glyph, shown when the window is at its normal size. */
function MaximizeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
    </svg>
  );
}

/** Two offset squares: the restore glyph, shown when the window is maximized. */
function RestoreIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5.5" width="7" height="7" rx="1.2" />
      <path d="M6 5.5V4.4Q6 3.3 7.1 3.3H11.6Q12.7 3.3 12.7 4.4V8.9Q12.7 10 11.6 10H10.9" />
    </svg>
  );
}

/** Two crossed lines: the close glyph. */
function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4.5" y1="4.5" x2="11.5" y2="11.5" />
      <line x1="11.5" y1="4.5" x2="4.5" y2="11.5" />
    </svg>
  );
}

/**
 * The custom window chrome that replaces the native title bar: the brand and the active workspace
 * path on the left, a drag region filling the middle, and the minimize / maximize / close controls
 * on the right. Ambient ground, no divider - it parts from the content by space. The window calls
 * are guarded so the bar still renders outside the desktop shell.
 */
export function TitleBar() {
  const workspace = useWorkspace();
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

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          onClick={minimizeWindow}
          aria-label={t((d) => d.window.minimize)}
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className={styles.control}
          onClick={toggleMaximizeWindow}
          aria-label={maximized ? t((d) => d.window.restore) : t((d) => d.window.maximize)}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          type="button"
          className={`${styles.control} ${styles.close}`}
          onClick={closeWindow}
          aria-label={t((d) => d.window.close)}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
