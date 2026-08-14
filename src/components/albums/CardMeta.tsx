// -- Style Imports --
import styles from "./CardMeta.module.css";

/**
 * The text block below a tile: a title, a secondary line, and a quieter sub line. Takes ready
 * strings and renders the secondary and sub lines only when they carry text, so an untitled or
 * single-line card stays clean.
 */
export function CardMeta({
  title,
  secondary,
  sub,
}: {
  title: string;
  secondary?: string;
  sub?: string;
}) {
  return (
    <div className={styles.meta}>
      <span className={styles.title}>{title}</span>
      {secondary ? <span className={styles.secondary}>{secondary}</span> : null}
      {sub ? <span className={styles.sub}>{sub}</span> : null}
    </div>
  );
}
