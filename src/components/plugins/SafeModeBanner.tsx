// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { RestartFailure } from "./RestartFailure";

// -- State Imports --
import { usePluginRuntime } from "../../state/plugins/store";
import { useRestart } from "../../state/plugins/useRestart";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { PluginErrorKey } from "../../state/plugins/errors";

// -- Style Imports --
import styles from "./SafeModeBanner.module.css";

/** The strip itself: a quiet dot, the line, the one way out, and why a refused restart did not happen. */
export function SafeModeBannerView({
  onRestart,
  error = null,
  onDismiss = () => {},
}: {
  onRestart: () => void;
  error?: PluginErrorKey | null;
  onDismiss?: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.bar}>
      <span className={styles.dot} aria-hidden="true" />
      <span>{t((d) => d.plugins.safeBanner.line)}</span>
      <QuietButton onClick={onRestart}>{t((d) => d.plugins.safeBanner.restart)}</QuietButton>
      {error ? <RestartFailure error={error} onDismiss={onDismiss} /> : null}
    </div>
  );
}

/** Shown while the session runs without plugins. "Restart normally" relaunches with them on. */
export function SafeModeBanner() {
  const safe = usePluginRuntime() === "safe";
  const { error, restart, dismiss } = useRestart();
  if (!safe) return null;
  return <SafeModeBannerView onRestart={() => restart(false)} error={error} onDismiss={dismiss} />;
}
