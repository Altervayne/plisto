// -- Component Imports --
import { TitleBar } from "./components/shell/TitleBar";
import { WorkspaceGate } from "./components/WorkspaceGate";

// -- Style Imports --
import styles from "./App.module.css";

/** The app root: the window title bar over the workspace gate, so the bar shows on every screen. */
function App() {
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
