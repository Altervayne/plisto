// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { TitleBar } from "./components/shell/TitleBar";
import { WorkspaceGate } from "./components/WorkspaceGate";

// -- State Imports --
import { useLoadPreferences } from "./state/preferences/store";

// -- Hook Imports --
import { useExportNotifications } from "./hooks/useExportNotifications";

// -- Theme Imports --
import { useApplyTheme } from "./theme";

// -- Style Imports --
import styles from "./App.module.css";

/** The app root: the window title bar over the workspace gate, so the bar shows on every screen. */
function App() {
  const loadPreferences = useLoadPreferences();

  // Hydrate prefs before any screen renders, so theme and locale are live on the picker too. The
  // shell reloads them once the library opens; the read is idempotent.
  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  // Stamp the document root from the theme pref on every screen, not just inside the shell.
  useApplyTheme();

  // Notify on a finished or failed export while the window is hidden to tray.
  useExportNotifications();

  return (
    <div className={styles.frame}>
      <TitleBar />
      <div className={styles.content}>
        <WorkspaceGate />
      </div>
    </div>
  );
}

export default App;
