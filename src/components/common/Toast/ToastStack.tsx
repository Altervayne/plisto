// -- Framework Imports --
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// -- Style Imports --
import styles from "./Toast.module.css";

let host: HTMLDivElement | null = null;

/**
 * The single foot-of-window container every toast portals into, created on first use so toasts mounted
 * in different places still share one column instead of overlapping.
 */
function stackHost(): HTMLDivElement {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.className = styles.stack;
  document.body.appendChild(host);
  return host;
}

/** Places its children in the shared toast column at the window foot. */
export function ToastStack({ children }: { children: ReactNode }) {
  return createPortal(children, stackHost());
}
