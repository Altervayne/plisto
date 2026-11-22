// -- Icon Imports --
import { EyeOff, TriangleAlert } from "lucide-react";

// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";
import { Tooltip } from "../../common/Tooltip/Tooltip";
import { TruncatedText } from "../../common/TruncatedText/TruncatedText";
import { TextLink } from "../../plugins/TextLink";

// -- State Imports --
import { usePluginThumb } from "../../../state/player/pluginVis/thumbs";
import { useT } from "../../../i18n";
import { isDarkTheme, useTheme } from "../../../theme";

// -- Type Imports --
import type { CatalogRow } from "./useCatalogRows";

// -- Style Imports --
import styles from "./CatalogTile.module.css";

/** Why Plisto stopped a plugin kind, and what turns it back on. */
export interface TileStop {
  cause: "flash" | "reset";
  onTurnBack: () => void;
}

/**
 * One kind on the catalog page: its still, its name and its own switch. A turned-off kind, or any kind
 * of a turned-off family, reads dimmed. The switch shows the kind's own stored state either way. A kind
 * Plisto stopped says why under its name, dimmed, with the one way back; a kind no flash meter watches
 * says so.
 */
export function CatalogTile({
  row,
  on,
  dimmed,
  disabled,
  lockedNote,
  stop,
  unwatched = false,
  turnBackFailed = false,
  onChange,
}: {
  row: CatalogRow;
  on: boolean;
  dimmed: boolean;
  disabled: boolean;
  // Tooltip on the switch while the last-on guard holds it.
  lockedNote?: string;
  stop?: TileStop | null;
  unwatched?: boolean;
  /** The last Turn back on was refused. */
  turnBackFailed?: boolean;
  onChange: (on: boolean) => void;
}) {
  const t = useT();
  // Subscribed so the still follows a theme change; isDarkTheme resolves "system".
  useTheme();
  const theme = isDarkTheme() ? "dark" : "light";
  // A plugin kind's still is rendered at runtime and follows its build; a built-in's is a shipped file.
  const pluginSrc = usePluginThumb(row.id, theme);
  const src = row.source === "plugin" ? pluginSrc : row.thumb(theme);
  const name = t(row.label);
  return (
    <div className={dimmed || stop ? `${styles.tile} ${styles.dim}` : styles.tile} data-kind={row.id}>
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
      {stop ? (
        <span className={styles.mark}>
          <span className={styles.markLine}>
            <TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>
              {stop.cause === "flash"
                ? t((d) => d.plugins.vis.stoppedFlash)
                : t((d) => d.plugins.vis.stoppedReset)}
            </span>
          </span>
          <TextLink onClick={stop.onTurnBack}>{t((d) => d.plugins.vis.turnBackOn)}</TextLink>
          {turnBackFailed ? (
            <span className={styles.markLine}>{t((d) => d.plugins.vis.turnBackFailed)}</span>
          ) : null}
        </span>
      ) : unwatched ? (
        <span className={`${styles.mark} ${styles.quiet}`}>
          <span className={styles.markLine}>
            <EyeOff size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{t((d) => d.plugins.vis.notWatched)}</span>
          </span>
        </span>
      ) : null}
    </div>
  );
}
