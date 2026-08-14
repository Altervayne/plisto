// -- Framework Imports --
import type { CSSProperties, ReactNode, RefObject } from "react";

// -- Hook Imports --
import { useScrollbar } from "./useScrollbar";

// -- Style Imports --
import styles from "./ScrollArea.module.css";

/**
 * A scroll container that renders the app's own scrollbar in place of the engine's chrome. Content
 * scrolls in a real overflow viewport, so the native handles wheel, touch, keyboard, and momentum;
 * the native bar is only hidden, never stylized, so nothing depends on the webview version. A DOM
 * track and thumb overlay the right edge, reflecting scrollTop and steering it on drag. The thumb is
 * the only interactive part, so the transparent track never intercepts clicks meant for the content.
 *
 * Vertical only for now: a horizontal bar is a clean addition along the same seam. The viewport
 * element is handed back through viewportRef so a virtualizer can scroll this exact surface.
 */
export function ScrollArea({
  children,
  className,
  contentClassName,
  viewportRef,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  const bar = useScrollbar(viewportRef);

  return (
    <div className={`${styles.wrapper} ${className ?? ""}`}>
      <div className={`${styles.viewport} hide-native-scrollbar`} ref={bar.setViewport}>
        <div className={`${styles.content} ${contentClassName ?? ""}`} ref={bar.contentRef}>
          {children}
        </div>
      </div>

      <div className={styles.scrollbar} ref={bar.trackRef} aria-hidden="true">
        {bar.thumb ? (
          <div
            className={styles.thumb}
            data-dragging={bar.dragging ? "" : undefined}
            style={
              {
                "--thumb-size": `${bar.thumb.size}px`,
                "--thumb-offset": `${bar.thumb.offset}px`,
              } as CSSProperties
            }
            onPointerDown={bar.onThumbPointerDown}
            onPointerMove={bar.onThumbPointerMove}
            onPointerUp={bar.onThumbPointerEnd}
            onPointerCancel={bar.onThumbPointerEnd}
          />
        ) : null}
      </div>
    </div>
  );
}
