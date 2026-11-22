// -- Framework Imports --
import type { ReactNode } from "react";

// -- Style Imports --
import styles from "./TextLink.module.css";

/** A button drawn as an inline text link, for a sentence that points somewhere else in the app. */
export function TextLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" className={styles.link} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * Places a link inside a translated sentence at its `{link}` slot. A sentence with no slot is returned
 * as it is, so a missing token never drops the text.
 */
export function WithLink({ text, link }: { text: string; link: ReactNode }) {
  const [before, after] = text.split("{link}");
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}
