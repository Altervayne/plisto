// -- Library Imports --
import { Check } from "lucide-react";

// -- Framework Imports --
import type { ButtonHTMLAttributes, ReactNode } from "react";

// -- Local Imports --
import { VisualizerGlyph } from "../VisualizerGlyph";
import { VISUALIZER_VIEWS, thumbFor } from "../visualizerViews";

// -- State Imports --
import { useT } from "../../../../i18n";
import { isDarkTheme, useTheme } from "../../../../theme";

// -- Type Imports --
import type { VisualizerKind } from "../../../../state/player/visualizerKind";

// -- Style Imports --
import styles from "./KindTile.module.css";

interface KindTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "children"> {
  kind: VisualizerKind;
  checked: boolean;
  // A fixed width in px (the sheet); omitted, the tile fills its grid cell (the popover).
  width?: number;
  // A `KindTag` drawn over the thumb.
  tag?: ReactNode;
}

/**
 * One visualizer kind as a radio: an 8:5 still, the name, and an ink ring with a tick when checked. The
 * accent appears only as the focus-visible outline. The sunken ground and the glyph stand in while no still exists.
 */
export function KindTile({ kind, checked, width, tag, style, ...rest }: KindTileProps) {
  const t = useT();
  // Subscribed so the still follows a theme change; isDarkTheme resolves "system".
  useTheme();
  const src = thumbFor(kind, isDarkTheme() ? "dark" : "light");
  return (
    <button
      {...rest}
      type="button"
      role="radio"
      aria-checked={checked}
      data-nav=""
      data-kind={kind}
      className={styles.tile}
      style={width === undefined ? style : { ...style, width }}
    >
      <span className={styles.thumb}>
        {src ? (
          <img className={styles.img} src={src} alt="" draggable={false} />
        ) : (
          <span className={styles.glyph}>
            <VisualizerGlyph kind={kind} size={26} />
          </span>
        )}
        {checked ? (
          <span className={styles.tick}>
            <Check size={12} strokeWidth={2.6} aria-hidden="true" />
          </span>
        ) : null}
        {tag}
      </span>
      <span className={styles.name}>{t(VISUALIZER_VIEWS[kind].label)}</span>
    </button>
  );
}
