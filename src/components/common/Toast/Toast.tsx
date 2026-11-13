// -- Framework Imports --
import type { ReactNode } from "react";

// -- Hook Imports --
import { useMountTransition } from "../../../hooks/useMountTransition";

// -- Component Imports --
import { ToastStack } from "./ToastStack";

// -- Style Imports --
import styles from "./Toast.module.css";

/** The pill's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

/**
 * A neutral pill in the shared foot stack. It owns the mount transition: `visible` flips it in and out,
 * and it unmounts once the exit has played. `plugin` pills stack above Plisto's own.
 */
export function Toast({
  visible,
  children,
  className,
  plugin = false,
}: {
  visible: boolean;
  children: ReactNode;
  className?: string;
  plugin?: boolean;
}) {
  const toast = useMountTransition(visible, EXIT_MS);
  if (!toast.mounted) return null;

  const classes = [styles.toast, plugin ? styles.plugin : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <ToastStack>
      <div className={classes} data-state={toast.state} role="status" aria-live="polite">
        {children}
      </div>
    </ToastStack>
  );
}
