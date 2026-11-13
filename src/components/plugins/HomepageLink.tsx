// -- Utils Imports --
import { openLink } from "../../lib/opener";

// -- Style Imports --
import styles from "./HomepageLink.module.css";

/**
 * A plugin's declared website. An http or https address is a link that opens in the system browser,
 * never in the app window; anything else is shown as plain text.
 */
export function HomepageLink({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return <span className={styles.plain}>{url}</span>;
  return (
    <button type="button" className={styles.link} onClick={() => void openLink(url)}>
      {url}
    </button>
  );
}
