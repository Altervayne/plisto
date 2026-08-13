// -- Framework Imports --
import React from "react";
import ReactDOM from "react-dom/client";

// -- Component Imports --
import App from "./App";

// -- Style Imports --
import "./styles/tokens.css";
import "./styles/base.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
