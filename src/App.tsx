// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { TitleBar } from "./components/shell/TitleBar";
import { WorkspaceGate } from "./components/WorkspaceGate";
import { AppShell } from "./components/shell/AppShell";
import { ConfirmQuitDialog } from "./components/shell/ConfirmQuitDialog";
import { ErrorBoundary } from "./components/common/ErrorBoundary";

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
 * probe picks the content - standalone player mode when the launch opened a file, else the full library
 * gate. It holds nothing while the probe is in flight, so neither tree flashes. "Open library" from the
 * player reveals the sidebar in place without re-booting the library.
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
  // Whether the standalone player has opened the library. One-way for the session; the standalone shell
  // owns the reveal by expanding its sidebar, so the full app never remounts.
  const [expanded, setExpanded] = useState(false);
  const openLibrary = () => setExpanded(true);
  const playerOnly = boot.phase === "standalone" && !expanded;

  return (
    <div className={styles.frame}>
      <TitleBar playerOnly={playerOnly} onOpenLibrary={openLibrary} />
      <div className={styles.content}>
        {/* The title bar sits above this, outside the boundary, so its window controls survive a crash
            in the content below. */}
        <ErrorBoundary>
          {boot.phase === "pending" ? null : boot.phase === "standalone" ? (
            <AppShell
              standalone
              initialFiles={boot.files}
              sidebarExpanded={expanded}
              onOpenLibrary={openLibrary}
            />
          ) : (
            <WorkspaceGate />
          )}
        </ErrorBoundary>
      </div>
      <ConfirmQuitDialog />
    </div>
  );
}

export default App;
