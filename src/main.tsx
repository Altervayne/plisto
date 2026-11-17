// -- Framework Imports --
import React from "react";
import ReactDOM from "react-dom/client";

// -- Component Imports --
import App from "./App";
import { TrayStatus } from "./components/tray/TrayStatus";
import { NowPlayingWidget } from "./components/player/NowPlayingWidget";

// -- Style Imports --
import "./styles/tokens.css";
import "./styles/base.css";

// The satellite windows load this same bundle with a ?window= tag and route to their own lightweight
// tree off the query param synchronously, so neither mounts the full app shell. The tray popup and
// the pop-out now-playing widget each get their own root; anything else is the main app.
const target = new URLSearchParams(location.search).get("window");

// Dev builds only: the main window opens the probes page on Ctrl+Alt+Shift+P. Both the key and the page
// sit behind the DEV flag, so a production build carries neither.
if (import.meta.env.DEV && target === null) {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey && e.shiftKey && e.code === "KeyP") location.search = "?window=probes";
  });
}

function root() {
  if (target === "tray") return <TrayStatus />;
  if (target === "nowplaying") return <NowPlayingWidget />;
  if (import.meta.env.DEV && target === "probes") {
    const ProbesPage = React.lazy(() => import("./dev/probes/ProbesPage"));
    return (
      <React.Suspense fallback={null}>
        <ProbesPage />
      </React.Suspense>
    );
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root()}</React.StrictMode>,
);
