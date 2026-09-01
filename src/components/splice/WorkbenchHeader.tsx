// -- Component Imports --
import { Breadcrumb } from "../files/Breadcrumb";

// -- Type Imports --
import type { Crumb } from "../../state/files/folderTree";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./WorkbenchHeader.module.css";

/**
 * The workbench header: a breadcrumb back to the library, the source filename in mono, and a small
 * format badge. Mirrors the album pane's breadcrumb-over-body chassis, so the two full-pane surfaces
 * read alike.
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
    { id: "library", name: t((d) => d.splice.back) },
    { id: "tool", name: verb === "split" ? t((d) => d.splice.splitTitle) : t((d) => d.splice.trimTitle) },
  ];

  return (
    <div className={styles.header}>
      <Breadcrumb
        crumbs={crumbs}
        atRoot={false}
        onNavigate={(id) => {
          if (id === "library") onBack();
        }}
        onUp={onBack}
      />
      <span className={styles.filename}>{filename}</span>
      <span className={styles.badge}>{ext.toUpperCase()}</span>
    </div>
  );
}
