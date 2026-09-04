// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { TitleBar } from "./components/shell/TitleBar";
import { WorkspaceGate } from "./components/WorkspaceGate";
import { StandaloneView } from "./components/player/StandaloneView";
import { ConfirmQuitDialog } from "./components/shell/ConfirmQuitDialog";

// -- State Imports --
import { useLoadPreferences } from "./state/preferences/store";

// -- Hook Imports --
import { useExportNotifications } from "./hooks/useExportNotifications";
import { useStartupBoot } from "./hooks/useStartupBoot";

// -- Theme Imports --
import { useApplyTheme } from "./theme";

// -- Style Imports --
import styles from "./App.module.css";

/**
 * The app root: the window title bar over the content, so the bar shows on every screen. The startup
 * probe picks the content - the compact standalone player when the launch opened a file, else the full
 * library gate. It holds nothing while the probe is in flight, so neither tree flashes before it
 * resolves. "Open library" from the compact player escalates to the gate for the rest of the session.
 */
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

  const boot = useStartupBoot();
  const compact = boot.phase === "standalone" && !boot.escalated;

  return (
    <div className={styles.frame}>
      <TitleBar compact={compact} onOpenLibrary={boot.escalate} />
      <div className={styles.content}>
        {boot.phase === "pending" ? null : compact ? (
          <StandaloneView files={boot.files} onOpenLibrary={boot.escalate} />
        ) : boot.escalated ? (
          // The full app fades in as the window snaps up from the compact player, so the swap reads as
          // one motion rather than a hard cut.
          <div className={styles.escalate}>
            <WorkspaceGate />
          </div>
        ) : (
          <WorkspaceGate />
        )}
      </div>
      <ConfirmQuitDialog />
    </div>
  );
}

export default App;
