// -- Utils Imports --
import { knownCapabilities } from "../../../../state/plugins/capabilities";
import { isNewCapability, isNewOrigin } from "../../../../state/plugins/review";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/**
 * What the plugin asks for, in Plisto's own words: one line per capability, never the plugin's text.
 * A capability or network origin the approved version lacked carries a New badge. The network line
 * lists the declared origins beneath it as plain text. A capability value this Plisto has no label for
 * is not drawn (it is still granted unchanged).
 */
export function CapabilityList({ subject, heading }: { subject: ReviewSubject; heading: string }) {
  const t = useT();

  return (
    <div className={styles.sect}>
      <span className={styles.label}>{heading}</span>
      <ul className={styles.caps}>
        {knownCapabilities(subject.capabilities).map((cap) => (
          <li key={cap}>
            <div className={styles.capText}>
              {t((d) => d.plugins.capability[cap])}
              {isNewCapability(subject, cap) ? (
                <span className={styles.badge}>{t((d) => d.plugins.sheet.newBadge)}</span>
              ) : null}
              {cap === "network" && subject.origins.length > 0 ? (
                <ul className={styles.origins}>
                  {subject.origins.map((origin) => (
                    <li key={origin}>
                      {origin}
                      {isNewOrigin(subject, origin) ? (
                        <span className={styles.badge}>{t((d) => d.plugins.sheet.newBadge)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
