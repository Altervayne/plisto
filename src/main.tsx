// -- Framework Imports --
import React from "react";
import ReactDOM from "react-dom/client";

// -- Component Imports --
import App from "./App";
import { TrayStatus } from "./components/tray/TrayStatus";

// -- Style Imports --
import "./styles/tokens.css";
import "./styles/base.css";

// The tray popup loads this same bundle with ?window=tray, and routes to its own lightweight tree
// off the query param synchronously, so the popup never mounts the full app shell.
const isTray = new URLSearchParams(location.search).get("window") === "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isTray ? <TrayStatus /> : <App />}</React.StrictMode>,
);
