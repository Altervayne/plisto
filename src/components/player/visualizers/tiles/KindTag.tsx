// -- Style Imports --
import styles from "./KindTag.module.css";

/** The glass pill over a thumb: `filled` marks the default in effect, `set-aside` (outlined) the default an override replaced. */
export function KindTag({ form, label }: { form: "filled" | "set-aside"; label: string }) {
  return <span className={form === "set-aside" ? `${styles.tag} ${styles.setAside}` : styles.tag}>{label}</span>;
}
