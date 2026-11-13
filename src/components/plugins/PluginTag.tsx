// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { PluginTagKind } from "../../state/plugins/trust";

// -- Style Imports --
import styles from "./PluginTag.module.css";

/** The pill that marks a plugin as Native or Unsandboxed wherever its name appears. */
export function PluginTag({ kind }: { kind: PluginTagKind }) {
  const t = useT();
  return (
    <span className={kind === "unsandboxed" ? `${styles.tag} ${styles.warn}` : styles.tag}>
      {kind === "native" ? t((d) => d.plugins.tagNative) : t((d) => d.plugins.tagUnsandboxed)}
    </span>
  );
}
