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

function root() {
  if (target === "tray") return <TrayStatus />;
  if (target === "nowplaying") return <NowPlayingWidget />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{root()}</React.StrictMode>,
);
