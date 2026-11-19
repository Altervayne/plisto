// -- Component Imports --
import { EmptyState } from "./common/EmptyState";
import { QuietButton } from "./common/QuietButton";

// -- State Imports --
import { useRetryBoot } from "../state/store";

// -- i18n Imports --
import { useT } from "../i18n";

/** What the boot gate shows when the folder or track read has not landed after the stall threshold. */
export function BootStalled() {
  const retry = useRetryBoot();
  const t = useT();
  return (
    <EmptyState
      tone="warn"
      title={t((d) => d.projections.bootStalledTitle)}
      line={t((d) => d.projections.stalledLine)}
      action={<QuietButton onClick={retry}>{t((d) => d.projections.tryAgain)}</QuietButton>}
    />
  );
}
