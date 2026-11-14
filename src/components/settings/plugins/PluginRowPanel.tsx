// -- Component Imports --
import { HomepageLink } from "../../plugins/HomepageLink";
import { QuietButton } from "../../common/QuietButton";

// -- State Imports --
import { usePlugins } from "../../../state/plugins/store";
import { useAppMode } from "../../../state/player/store";
import { useRequestPluginPage } from "../../../state/shell/store";

// -- Utils Imports --
import { qualifiedPlugins } from "../../shell/navVisibility";
import { knownCapabilities, sortCapabilities } from "../../../state/plugins/capabilities";
import { isDevOrigin } from "../../../state/plugins/origins";
import { formatBytes } from "../../../lib/format";

// -- Hook Imports --
import { useDataSize } from "./useDataSize";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginRow } from "../../../types";

// -- Style Imports --
import styles from "./PluginRowPanel.module.css";

/**
 * The details under an open row: what the plugin was allowed to do, its author and website as declared,
 * and Open settings (for a plugin with a page in the rail), Disable and Uninstall.
 */
export function PluginRowPanel({
  row,
  busy,
  onToggle,
  onUninstall,
}: {
  row: PluginRow;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onUninstall: () => void;
}) {
  const t = useT();
  const m = row.manifest;
  const granted = sortCapabilities(knownCapabilities(row.granted));
  const size = useDataSize(row.id);
  const rows = usePlugins();
  const appMode = useAppMode();
  const requestPage = useRequestPluginPage();
  // Only a plugin the rail draws has a page to land on; anything else is reachable from this hub alone.
  const hasPage =
    row.state === "ready" &&
    row.enabled &&
    row.tier === "ui" &&
    qualifiedPlugins(rows, appMode).some((plugin) => plugin.id === row.id);

  return (
    <div className={styles.panel}>
      <dl className={styles.facts}>
        {row.state === "ready" && granted.length > 0 ? (
          <>
            <dt>{t((d) => d.plugins.panelCan)}</dt>
            <dd>
              <ul className={styles.can}>
                {granted.map((cap) => (
                  <li key={cap}>
                    {t((d) => d.plugins.capability[cap])}
                    {cap === "network" && row.granted_origins.length > 0 ? (
                      <ul className={styles.origins}>
                        {row.granted_origins.map((origin) => (
                          <li key={origin}>
                            {origin}
                            {isDevOrigin(origin) ? (
                              <span className={styles.devTag}>{t((d) => d.plugins.sheet.devOrigin)}</span>
                            ) : null}
                          </li>
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
        {hasPage ? (
          <QuietButton onClick={() => requestPage(row.id, "settings")}>
            {t((d) => d.plugins.ui.openSettings)}
          </QuietButton>
        ) : null}
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
