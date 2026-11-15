// -- Framework Imports --
import type { ReactNode } from "react";

// -- Local Imports --
import { settingAnchorId } from "./settingsRegistry";

// -- Type Imports --
import type { HubSettingId, SettingId } from "./settingsRegistry";

/**
 * Stamps a row with its registry id: a `data-setting-id` attribute and a DOM id that works as a scroll
 * anchor. It adds no style of its own; pass the row's existing class as `className` so the wrapper takes
 * the row's place in its layout instead of adding a box.
 */
export function SettingRow({
  id,
  className,
  children,
}: {
  id: SettingId | HubSettingId;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div id={settingAnchorId(id)} data-setting-id={id} className={className}>
      {children}
    </div>
  );
}
