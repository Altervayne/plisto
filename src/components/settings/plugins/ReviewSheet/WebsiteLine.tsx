// -- Component Imports --
import { HomepageLink } from "../../../plugins/HomepageLink";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/** The plugin's declared website. A web address opens in the system browser; anything else is text. */
export function WebsiteLine({ url }: { url: string | null }) {
  const t = useT();
  if (!url) return null;
  return (
    <p className={styles.note}>
      {t((d) => d.plugins.panelHomepage)}: <HomepageLink url={url} />
    </p>
  );
}
