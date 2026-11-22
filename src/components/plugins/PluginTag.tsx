// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { PluginTagKind } from "../../state/plugins/trust";

// -- Style Imports --
import styles from "./PluginTag.module.css";

/** The pill that marks a plugin as Native or Unsandboxed wherever its name appears, or as a plain Plugin. */
export function PluginTag({ kind }: { kind: PluginTagKind | "plugin" }) {
  const t = useT();
  return (
    <span className={kind === "unsandboxed" ? `${styles.tag} ${styles.warn}` : styles.tag}>
      {kind === "native"
        ? t((d) => d.plugins.tagNative)
        : kind === "plugin"
          ? t((d) => d.plugins.vis.tag)
          : t((d) => d.plugins.tagUnsandboxed)}
    </span>
  );
}
