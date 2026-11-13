// -- Component Imports --
import { HomepageLink } from "../../plugins/HomepageLink";
import { QuietButton } from "../../common/QuietButton";
import { SegmentedControl } from "../../common/SegmentedControl";

// -- Utils Imports --
import { knownCapabilities, sortCapabilities } from "../../../state/plugins/capabilities";
import { formatBytes } from "../../../lib/format";
import { effectiveLayout } from "../../shell/navVisibility";

// -- Hook Imports --
import { useDataSize } from "./useDataSize";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { Segment } from "../../common/SegmentedControl";
import type { PluginRow, PluginSidebarLayout } from "../../../types";

// -- Style Imports --
import styles from "./PluginRowPanel.module.css";

/** A plugin with at least this many sidebar entries can choose between a section and one compact row. */
const LAYOUT_CHOICE_MIN_ITEMS = 2;

/**
 * The details under an open row: the sidebar layout choice (only for a plugin with several sidebar
 * entries), what it was allowed to do, its author and website as declared, and Disable and Uninstall.
 */
export function PluginRowPanel({
  row,
  busy,
  onToggle,
  onUninstall,
  onLayout,
}: {
  row: PluginRow;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onUninstall: () => void;
  onLayout: (layout: PluginSidebarLayout) => void;
}) {
  const t = useT();
  const m = row.manifest;
  const layouts: Segment<PluginSidebarLayout>[] = [
    { value: "section", label: t((d) => d.plugins.layoutSection), disabled: busy },
    { value: "compact", label: t((d) => d.plugins.layoutCompact), disabled: busy },
  ];
  const granted = sortCapabilities(knownCapabilities(row.granted));
  const size = useDataSize(row.id);

  return (
    <div className={styles.panel}>
      {m && m.sidebar_items >= LAYOUT_CHOICE_MIN_ITEMS ? (
        <div className={styles.rowx}>
          <span>{t((d) => d.plugins.panelSidebar)}</span>
          <SegmentedControl
            segments={layouts}
            value={effectiveLayout(row)}
            onChange={onLayout}
            label={t((d) => d.plugins.panelSidebar)}
          />
        </div>
      ) : null}
      <dl className={styles.facts}>
        {row.state === "ready" && granted.length > 0 ? (
          <>
            <dt>{t((d) => d.plugins.panelCan)}</dt>
            <dd>
              <ul className={styles.can}>
                {granted.map((cap) => (
                  <li key={cap}>
                    {t((d) => d.plugins.capability[cap])}
                    {cap === "network" && m && m.origins.length > 0 ? (
                      <ul className={styles.origins}>
                        {m.origins.map((origin) => (
                          <li key={origin}>{origin}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {m ? (
          <>
            <dt>{t((d) => d.plugins.panelAuthor)}</dt>
            <dd>{t((d) => d.plugins.panelAuthorValue, { author: m.author })}</dd>
            {m.homepage ? (
              <>
                <dt>{t((d) => d.plugins.panelHomepage)}</dt>
                <dd>
                  <HomepageLink url={m.homepage} />
                </dd>
              </>
            ) : null}
          </>
        ) : null}
        {size.status === "ready" ? (
          <>
            <dt>{t((d) => d.plugins.panelSavedData)}</dt>
            <dd>{size.bytes > 0 ? formatBytes(size.bytes) : t((d) => d.plugins.savedNone)}</dd>
          </>
        ) : null}
      </dl>
      <div className={styles.foot}>
        {row.state === "ready" && row.enabled ? (
          <QuietButton onClick={() => onToggle(false)} disabled={busy}>
            {t((d) => d.plugins.disable)}
          </QuietButton>
        ) : null}
        <QuietButton destructive onClick={onUninstall} disabled={busy}>
          {t((d) => d.plugins.uninstall)}
        </QuietButton>
      </div>
    </div>
  );
}
