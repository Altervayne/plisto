// -- Framework Imports --
import type { Ref } from "react";

// -- Icon Imports --
import { Maximize2 } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../../common/IconButton";
import { Tooltip } from "../../common/Tooltip";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./AmbientButton.module.css";

/**
 * The way into ambient mode: a quiet glyph beside the speaker. With nothing playing it shows disabled,
 * and a tooltip on a wrapper says why, since a disabled button takes no pointer events of its own.
 */
export function AmbientButton({
  onEnter,
  disabled = false,
  ref,
}: {
  onEnter?: () => void;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const t = useT();
  const glyph = <Maximize2 size={18} strokeWidth={1.8} />;

  if (disabled) {
    return (
      <Tooltip label={t((d) => d.player.ambientNothingPlaying)} placement="bottom">
        <span className={styles.disabledWrap}>
          <IconButton ref={ref} aria-label={t((d) => d.player.ambientMode)} disabled>
            {glyph}
          </IconButton>
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={t((d) => d.player.ambientMode)}>
      <IconButton ref={ref} aria-label={t((d) => d.player.ambientMode)} onClick={onEnter}>
        {glyph}
      </IconButton>
    </Tooltip>
  );
}
