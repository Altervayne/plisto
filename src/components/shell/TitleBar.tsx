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

// -- Icon Imports --
import { Minus, Square, Copy, X } from "lucide-react";

// -- Asset Imports --
// The mark is the same P + spectrum staff in both; only the notes change - platinum glows on the dark
// ground, steel reads on the light one. The theme picks which renders (see the module CSS).
import logoPlatinum from "../../assets/plisto-logo-final.svg";
import logoSteel from "../../assets/plisto-logo-steel.svg";

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
        <img src={logoPlatinum} alt="" aria-hidden="true" className={`${styles.logo} ${styles.platinum}`} />
        <img src={logoSteel} alt="" aria-hidden="true" className={`${styles.logo} ${styles.steel}`} />
        <span className={styles.name}>Plisto</span>
      </div>

      {workspace ? (
        <div className={styles.workspace} title={workspace}>
          <span className={styles.dot} aria-hidden="true" />
          {/* The folder name reads lighter than the full path; the path stays on hover. */}
          <span className={styles.path}>{folderName(workspace)}</span>
        </div>
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
          {maximized ? <Copy size={16} strokeWidth={1.3} /> : <Square size={16} strokeWidth={1.3} />}
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
