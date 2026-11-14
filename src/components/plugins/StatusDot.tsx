// -- Component Imports --
import { Tooltip } from "../common/Tooltip";

// -- Utils Imports --
import { statusLabel } from "./statusText";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { StatusView } from "../../state/plugins/statusModel";

// -- Style Imports --
import styles from "./StatusDot.module.css";

/**
 * The rail's status dot after a plugin's name: grey idle, cyan on, amber warn, drawn from the status
 * view alone and nothing when the view has none. Static: tone changes are instant and nothing pulses.
 * The tooltip carries the same words as the view's tip, the plugin's own report included, as text.
 */
export function StatusDot({ view, name }: { view: StatusView; name: string }) {
  const t = useT();
  if (!view.dot) return null;
  const text = view.tip ? statusLabel(view.tip, t) : null;
  const label = text ? t((d) => d.plugins.status.dotLabel, { name, text }) : name;
  const dot = <span className={`${styles.dot} ${styles[view.dot]}`} role="img" aria-label={label} />;
  return text ? <Tooltip label={label}>{dot}</Tooltip> : dot;
}
