// -- Framework Imports --
import { useMemo } from "react";

// -- Component Imports --
import { SafeModeOfferDialog } from "./SafeModeOfferDialog";

// -- State Imports --
import { createOfferGate } from "../../state/plugins/safeOffer";
import { usePluginRuntime, usePluginsStore } from "../../state/plugins/store";

// -- IPC Imports --
import { pluginsResolveBoot } from "../../lib/ipc";

/** Shows the offer while Rust holds the runtime, and sends the user's one answer back to it. */
export function SafeModeOffer() {
  const runtime = usePluginRuntime();
  const answer = useMemo(
    () => createOfferGate(pluginsResolveBoot, (boot) => usePluginsStore.getState().applyBoot(boot)),
    [],
  );
  return <SafeModeOfferDialog open={runtime === "held"} onAnswer={answer} />;
}
