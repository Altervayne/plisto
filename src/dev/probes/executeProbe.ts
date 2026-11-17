/*
 * Runs one probe or one card action to its end for the runner. The next run must not start while this one's
 * own cleanup is still in flight: after a stop or a timeout the probe gets a grace time to settle, and when
 * it does not, the shell resets the stages and the theme itself and says so. Actions a probe offered stay
 * with its card whatever the end was, so nothing here touches them.
 */

// -- Local Imports --
import { CLEANUP_GRACE_MS, deadlineMs, runGuarded } from "./deadline";

// -- Type Imports --
import type { RunEnd } from "./deadline";
import type { ActionVerdict, CardResult, ProbeContext, ProbeModule, ProbeOutcome } from "./types";

export const UNCLEAN_NOTICE = "previous probe did not clean up";

export interface ExecuteDeps {
  /** Runs before the probe: forgets the card's last run and empties the stages, so nothing carries over. */
  prepare(): void;
  makeContext(signal: AbortSignal): ProbeContext;
  put(result: CardResult): void;
  /** Lines owner steps added to the card during the run. */
  extraLines(): string[];
  /** Puts the stages and the theme back to their resting state. */
  resetStages(): void;
  /** Reports a notice for the page line. */
  notice(text: string): void;
  graceMs?: number;
}

/** Runs `probe` to a result on its card. Resolves once the card holds its final state and cleanup is settled or reset. */
export async function executeProbe(probe: ProbeModule, stop: AbortSignal, deps: ExecuteDeps): Promise<void> {
  deps.prepare();
  const ms = deadlineMs(probe.timeoutMs);
  const keep = deps.extraLines;
  let clean = true;
  // The card ends at once, even while the probe's cleanup is still being waited for.
  const show = (end: RunEnd<ProbeOutcome>) => {
    if (end.kind === "done") deps.put({ state: end.value.state, lines: [...end.value.lines, ...keep()] });
    else if (end.kind === "timeout") deps.put({ state: "timed out", lines: [`no result after ${ms} ms`, ...keep()] });
    else deps.put({ state: "stopped", lines: ["stopped before a result", ...keep()] });
  };
  try {
    const run = await runGuarded(
      (signal) => probe.run(deps.makeContext(signal)),
      ms,
      stop,
      deps.graceMs ?? CLEANUP_GRACE_MS,
      show,
    );
    clean = run.clean;
  } catch (e) {
    deps.put({ state: "invalid", lines: [`error: ${e instanceof Error ? e.message : String(e)}`, ...keep()] });
  }
  if (!clean) {
    deps.resetStages();
    deps.notice(UNCLEAN_NOTICE);
  }
}

export interface ActionDeps {
  /** Runs before the action: empties the stages. */
  prepare(): void;
  makeContext(signal: AbortSignal): ProbeContext;
  appendLine(line: string): void;
  /** Applies an action's verdict to its card. */
  applyVerdict(verdict: ActionVerdict): void;
  resetStages(): void;
  notice(text: string): void;
  graceMs?: number;
}

const ACTION_DEADLINE_MS = 600_000;

/** Runs a card action; how it ended, when not normally, becomes a line on the card. */
export async function executeAction(
  label: string,
  run: (ctx: ProbeContext) => Promise<void | ActionVerdict>,
  stop: AbortSignal,
  deps: ActionDeps,
): Promise<void> {
  deps.prepare();
  let clean = true;
  try {
    const out = await runGuarded(
      (signal) => run(deps.makeContext(signal)),
      ACTION_DEADLINE_MS,
      stop,
      deps.graceMs ?? CLEANUP_GRACE_MS,
      (end) => {
        if (end.kind !== "done") deps.appendLine(`${label}: ${end.kind === "timeout" ? "timed out" : "stopped"}`);
      },
    );
    clean = out.clean;
    if (out.end.kind === "done" && out.end.value) deps.applyVerdict(out.end.value);
  } catch (e) {
    deps.appendLine(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!clean) {
    deps.resetStages();
    deps.notice(UNCLEAN_NOTICE);
  }
}
