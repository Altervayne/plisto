/*
 * The status line of a plugin's family, in the active language: the plugins list's own wording for each
 * state, with the count line while the family is on.
 */

// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { FamilyStatus } from "../../../state/plugins/pluginFamily";
import type { PluginRow } from "../../../types";

export function familyStatusText(
  status: FamilyStatus,
  row: PluginRow,
  count: { on: number; total: number },
  currentVersion: string | null,
  t: Translate,
): string {
  switch (status) {
    case "on":
      return t((d) => d.settings.visualizersOnCount, { n: count.on, total: count.total });
    case "off":
      return t((d) => d.plugins.statusOff);
    case "review":
      return t((d) => d.plugins.statusNeedsConsent);
    case "newer": {
      const compat = row.manifest?.compat;
      const version = compat?.state === "needs_newer" ? compat.min_plisto : null;
      if (version && currentVersion) {
        return t((d) => d.plugins.statusIncompatibleHave, { version, current: currentVersion });
      }
      return version
        ? t((d) => d.plugins.statusIncompatible, { version })
        : t((d) => d.plugins.statusIncompatibleNoReason);
    }
    case "broken":
      return row.problem
        ? t((d) => d.plugins.statusBroken, { reason: row.problem })
        : t((d) => d.plugins.statusBrokenNoReason);
    case "crash":
      return t((d) => d.plugins.status.hubCrashLoop);
    case "safe":
      return t((d) => d.plugins.statusSafe);
    case "offInPlugins":
      return t((d) => d.plugins.vis.offInPlugins);
  }
}
