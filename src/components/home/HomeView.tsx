// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { Bento } from "./Bento";
import { QuietButton } from "../common/QuietButton";
import { PrimaryButton } from "../common/PrimaryButton";
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- Hook Imports --
import { useHomeLayout } from "./useHomeLayout";

// -- State Imports --
import { useAppMode } from "../../state/player/store";

// -- Type Imports --
import type { Mode } from "../shell/navVisibility";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./HomeView.module.css";

/**
 * Home: the landing for every mode. It reads the app mode to load that mode's saved layout, falling
 * back to the mode's default seed on first visit, and lays it on the bento. At rest the boxes are live -
 * covers play, stats route. An explicit arrange mode is the only time the boxes become movable objects;
 * every edit persists to that mode's layout, so each mode keeps its own arrangement.
 */
export function HomeView({ onNavigate }: { onNavigate: (mode: Mode) => void }) {
  const t = useT();
  const appMode = useAppMode();
  const { layout, reorder, resize, cycle, remove, add, reset } = useHomeLayout(appMode);
  const [arranging, setArranging] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t((d) => d.home.title)}</h1>
        <div className={styles.actions}>
          {arranging ? (
            <>
              <QuietButton onClick={() => setResetOpen(true)}>
                {t((d) => d.home.reset)}
              </QuietButton>
              <PrimaryButton onClick={() => setArranging(false)}>
                {t((d) => d.home.done)}
              </PrimaryButton>
            </>
          ) : (
            <QuietButton onClick={() => setArranging(true)}>
              {t((d) => d.home.arrange)}
            </QuietButton>
          )}
        </div>
      </div>
      <div className={styles.body}>
        <Bento
          layout={layout}
          arranging={arranging}
          onNavigate={onNavigate}
          reorder={reorder}
          resize={resize}
          cycle={cycle}
          remove={remove}
          add={add}
        />
      </div>

      <ConfirmDialog
        open={resetOpen}
        prompt={t((d) => d.home.resetPrompt)}
        confirmLabel={t((d) => d.home.reset)}
        cancelLabel={t((d) => d.common.cancel)}
        onConfirm={reset}
        onClose={() => setResetOpen(false)}
      />
    </div>
  );
}
