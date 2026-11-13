// -- Framework Imports --
import { useState } from "react";

// -- Library Imports --
import { ChevronRight } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../../common/IconButton";
import { QuietButton } from "../../common/QuietButton";
import { PluginIcon } from "../../plugins/PluginIcon";
import { PluginTag } from "../../plugins/PluginTag";
import { PluginRowPanel } from "./PluginRowPanel";

// -- Utils Imports --
import { rowView } from "./rowModel";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { PluginRow as RowData } from "../../../types";
import type { RowStatus } from "./rowModel";

// -- Style Imports --
import styles from "./PluginRow.module.css";

/** The row's status line in the active language. */
function statusText(status: RowStatus, t: Translate, current: string | null): string {
  switch (status.kind) {
    case "on": {
      const on = t((d) => d.plugins.statusOn);
      return status.background ? `${on}. ${t((d) => d.plugins.statusBackground)}` : on;
    }
    case "off":
      return t((d) => d.plugins.statusOff);
    case "needsConsent":
      return t((d) => d.plugins.statusNeedsConsent);
    case "unreadable":
      return t((d) => d.plugins.statusUnreadable);
    case "broken":
      return status.reason
        ? t((d) => d.plugins.statusBroken, { reason: status.reason })
        : t((d) => d.plugins.statusBrokenNoReason);
    case "incompatible":
      if (status.minVersion && current) {
        return t((d) => d.plugins.statusIncompatibleHave, { version: status.minVersion, current });
      }
      return status.minVersion
        ? t((d) => d.plugins.statusIncompatible, { version: status.minVersion })
        : t((d) => d.plugins.statusIncompatibleNoReason);
  }
}

/**
 * One installed plugin in the hub: icon, name with its tag and version, one status line, and the one
 * action its state allows - the enable switch, Review, or Uninstall. A row that can be opened shows its
 * details panel under it. A row whose manifest cannot be read is named by its id, in the mono face.
 */
export function PluginRow({
  row,
  busy,
  onToggle,
  onReview,
  onUninstall,
  currentVersion,
}: {
  row: RowData;
  busy: boolean;
  /** The running Plisto version, when known, for an incompatible row's status line. */
  currentVersion: string | null;
  onToggle: (row: RowData, on: boolean) => void;
  onReview: (row: RowData) => void;
  onUninstall: (row: RowData) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const view = rowView(row);

  return (
    <div className={`${styles.wrap} ${open ? styles.open : ""}`}>
      <div className={`${styles.row} ${view.grey ? styles.grey : ""}`}>
        <PluginIcon
          source={row.manifest ? { kind: "installed", id: row.id, hash: row.manifest_hash } : null}
          size={32}
        />
        <div className={styles.main}>
          <div className={styles.name}>
            <span className={`${styles.nameText} ${row.manifest ? "" : styles.mono}`}>{view.name}</span>
            {view.tag ? <PluginTag kind={view.tag} /> : null}
            {view.version ? <span className={styles.version}>{view.version}</span> : null}
          </div>
          <div className={`${styles.status} ${view.warn ? styles.warn : ""}`}>
            {statusText(view.status, t, currentVersion)}
          </div>
        </div>
        <div className={styles.acts}>
          {view.action === "switch" ? (
            <button
              type="button"
              role="switch"
              aria-checked={row.enabled}
              aria-label={t((d) => d.plugins.enableLabel, { name: view.name })}
              className={styles.switch}
              disabled={busy || view.locked}
              onClick={() => onToggle(row, !row.enabled)}
            >
              <span className={styles.knob} aria-hidden="true" />
            </button>
          ) : null}
          {view.action === "review" ? (
            <QuietButton onClick={() => onReview(row)} disabled={busy}>
              {t((d) => d.plugins.review)}
            </QuietButton>
          ) : null}
          {view.action === "uninstall" ? (
            <QuietButton destructive onClick={() => onUninstall(row)} disabled={busy}>
              {t((d) => d.plugins.uninstall)}
            </QuietButton>
          ) : null}
          {view.expandable ? (
            <span className={styles.chevron}>
              <IconButton
                aria-label={t((d) => d.plugins.details)}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                <ChevronRight size={16} strokeWidth={1.8} />
              </IconButton>
            </span>
          ) : null}
        </div>
      </div>
      {open && view.expandable ? (
        <PluginRowPanel
          row={row}
          busy={busy}
          onToggle={(on) => onToggle(row, on)}
          onUninstall={() => onUninstall(row)}
        />
      ) : null}
    </div>
  );
}
