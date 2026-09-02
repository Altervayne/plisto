// -- Component Imports --
import { Breadcrumb } from "../files/Breadcrumb";

// -- Type Imports --
import type { Crumb } from "../../state/files/folderTree";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./WorkbenchHeader.module.css";

/**
 * The workbench header: a breadcrumb whose root is the Track Editor destination and whose leaf is the
 * open file's verb, the source filename in mono, and a small format badge. The root crumb and the
 * up control both close the open file, dropping back to the destination's idle prompt. Mirrors the
 * album pane's breadcrumb-over-body chassis, so the two full-pane surfaces read alike.
 */
export function WorkbenchHeader({
  verb,
  filename,
  ext,
  onBack,
}: {
  verb: "split" | "trim";
  filename: string;
  ext: string;
  onBack: () => void;
}) {
  const t = useT();
  const crumbs: Crumb[] = [
    { id: "editor", name: t((d) => d.splice.editorTitle) },
    { id: "tool", name: verb === "split" ? t((d) => d.splice.splitTitle) : t((d) => d.splice.trimTitle) },
  ];

  return (
    <div className={styles.header}>
      <Breadcrumb
        crumbs={crumbs}
        atRoot={false}
        onNavigate={(id) => {
          if (id === "editor") onBack();
        }}
        onUp={onBack}
      />
      <span className={styles.filename}>{filename}</span>
      <span className={styles.badge}>{ext.toUpperCase()}</span>
    </div>
  );
}
