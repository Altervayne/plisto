// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { invoke } from "@tauri-apps/api/core";

// -- Type Imports --
import type { AppInfo } from "./types";

// -- Style Imports --
import "./App.css";

// The link to the backend: connected once app_info returns, or 'preview' when the
// frontend runs outside the Tauri shell (a plain browser has no invoke).
type Backend =
  | { status: "loading" }
  | { status: "connected"; info: AppInfo }
  | { status: "preview" };

function App() {
  const [backend, setBackend] = useState<Backend>({ status: "loading" });

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then((info) => setBackend({ status: "connected", info }))
      .catch(() => setBackend({ status: "preview" }));
  }, []);

  return (
    <main className="shell">
      <div className="mark" aria-hidden="true" />
      <h1 className="wordmark">Plisto</h1>
      <p className="tagline">Local-first music library manager</p>
      <p className="status">
        <StatusDot backend={backend} />
        <StatusText backend={backend} />
      </p>
    </main>
  );
}

function StatusDot({ backend }: { backend: Backend }) {
  const tone =
    backend.status === "connected"
      ? "good"
      : backend.status === "preview"
        ? "warn"
        : "idle";
  return <span className={`dot dot-${tone}`} />;
}

function StatusText({ backend }: { backend: Backend }) {
  switch (backend.status) {
    case "loading":
      return <span>Connecting to backend...</span>;
    case "connected":
      return (
        <span>
          Backend connected <span className="tabular ver">v{backend.info.version}</span>
        </span>
      );
    case "preview":
      return <span>Browser preview - backend runs inside the desktop shell</span>;
  }
}

export default App;
