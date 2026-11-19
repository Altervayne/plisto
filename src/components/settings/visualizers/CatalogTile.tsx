// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";
import { Tooltip } from "../../common/Tooltip/Tooltip";
import { TruncatedText } from "../../common/TruncatedText/TruncatedText";

// -- State Imports --
import { useT } from "../../../i18n";
import { isDarkTheme, useTheme } from "../../../theme";

// -- Type Imports --
import type { CatalogRow } from "./useCatalogRows";

// -- Style Imports --
import styles from "./CatalogTile.module.css";

/**
 * One kind on the catalog page: its still, its name and its own switch. A turned-off kind, or any kind
 * of a turned-off family, reads dimmed. The switch shows the kind's own stored state either way.
 */
export function CatalogTile({
  row,
  on,
  dimmed,
  disabled,
  lockedNote,
  onChange,
}: {
  row: CatalogRow;
  on: boolean;
  dimmed: boolean;
  disabled: boolean;
  // Tooltip on the switch while the last-on guard holds it.
  lockedNote?: string;
  onChange: (on: boolean) => void;
}) {
  const t = useT();
  // Subscribed so the still follows a theme change; isDarkTheme resolves "system".
  useTheme();
  const src = row.thumb(isDarkTheme() ? "dark" : "light");
  const name = t(row.label);
  return (
    <div className={dimmed ? `${styles.tile} ${styles.dim}` : styles.tile} data-kind={row.id}>
      <span className={styles.thumb}>
        {src ? (
          <img className={styles.img} src={src} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className={styles.glyph}>{row.glyph}</span>
        )}
      </span>
      <span className={styles.row}>
        <TruncatedText text={name} className={styles.name} />
        <Tooltip label={lockedNote}>
          <span>
            <Switch checked={on} onChange={onChange} label={name} disabled={disabled} />
          </span>
        </Tooltip>
      </span>
    </div>
  );
}
