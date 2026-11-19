// -- Icon Imports --
import { Feather, Zap } from "lucide-react";

// -- Component Imports --
import { Tooltip } from "../../../common/Tooltip/Tooltip";

// -- State Imports --
import { groupMark } from "../../../../state/player/visualizerRegistry";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./FamilyMark.module.css";

/** The mark's words for a family, or null when it has none. */
export function markLabel(id: string, t: ReturnType<typeof useT>): string | null {
  const mark = groupMark(id);
  if (!mark) return null;
  return mark === "flash" ? t((d) => d.player.markCanFlash) : t((d) => d.player.markCalmer);
}

/**
 * The temperament a family carries, read from the registry: an icon and a label, or the icon alone with
 * the label as its accessible name. A family with no mark renders nothing.
 */
export function FamilyMark({ id, iconOnly = false }: { id: string; iconOnly?: boolean }) {
  const t = useT();
  const mark = groupMark(id);
  if (!mark) return null;
  const label = mark === "flash" ? t((d) => d.player.markCanFlash) : t((d) => d.player.markCalmer);
  const Icon = mark === "flash" ? Zap : Feather;
  const icon = <Icon size={13} strokeWidth={1.8} aria-hidden="true" />;
  const className = mark === "flash" ? `${styles.mark} ${styles.flash}` : styles.mark;
  return iconOnly ? (
    <Tooltip label={label}>
      <span className={className} role="img" aria-label={label}>
        {icon}
      </span>
    </Tooltip>
  ) : (
    <span className={className}>
      {icon}
      {label}
    </span>
  );
}
