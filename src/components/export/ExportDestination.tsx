// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Icon Imports --
import { FolderOpen, Smartphone } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { ExportTarget } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

/**
 * The destination control: a bordered, iconed button that reads plainly as an action, over a quieter
 * device doorway beneath it, over the chosen line when one is set. A folder shows its path mono and
 * truncated; a device shows its shell breadcrumb in sans, each beside a good-tone dot with the full
 * text on hover.
 */
export function ExportDestination({
  target,
  onPickFolder,
  onPickDevice,
}: {
  target: ExportTarget | null;
  onPickFolder: () => void;
  onPickDevice: () => void;
}) {
  const t = useT();

  return (
    <div className={styles.destination}>
      <button type="button" className={styles.destButton} onClick={onPickFolder}>
        <FolderOpen size={16} strokeWidth={1.9} aria-hidden="true" />
        {target?.kind === "folder"
          ? t((d) => d.export.changeDestination)
          : t((d) => d.export.chooseDestination)}
      </button>
      <QuietButton onClick={onPickDevice}>
        {target?.kind === "device"
          ? t((d) => d.export.changeDevice)
          : t((d) => d.export.chooseDevice)}
      </QuietButton>
      {target?.kind === "folder" ? (
        <Tooltip label={target.path}>
          <span className={styles.chosen}>
            <span className={styles.chosenDot} aria-hidden="true" />
            <span className={styles.chosenPath}>{target.path}</span>
          </span>
        </Tooltip>
      ) : target?.kind === "device" ? (
        <Tooltip label={target.target.display}>
          <span className={styles.chosen}>
            <span className={styles.chosenDot} aria-hidden="true" />
            <Smartphone size={14} strokeWidth={1.9} aria-hidden="true" />
            <span className={styles.chosenDevice}>{target.target.display}</span>
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}
