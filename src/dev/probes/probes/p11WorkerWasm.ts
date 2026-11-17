/*
 * Runs one fixture that starts a blob worker and instantiates an inline WebAssembly module on a frame
 * under the UI policy and on a frame under the visualizer policy, and reports what each did. The outcome
 * is a measurement either way; the expected one is stated beside it.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { awaitMessage } from "./transportStandIn";

// -- Type Imports --
import type { ProbeHost } from "../frames";
import type { OutcomeState, ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const RUN_TIMEOUT_MS = 10_000;
const HOSTS: { host: ProbeHost; expectWorks: boolean }[] = [
  { host: "probe-ui1", expectWorks: false },
  { host: "probe-vis", expectWorks: true },
];

interface Try {
  ok: boolean;
  detail: string;
}

interface WorkerResult {
  type: string;
  worker: Try;
  wasm: Try;
  violations: string[];
}

/** Measured when any host answered; invalid when none did, since there is then nothing to report. */
export function judgeWorkerWasm(answered: readonly boolean[]): OutcomeState {
  return answered.some(Boolean) ? "measured" : "invalid";
}

const word = (t: Try) => (t.ok ? `ran (${t.detail})` : `refused or failed (${t.detail})`);

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const lines: string[] = [];
  const answered: boolean[] = [];
  for (const { host, expectWorks } of HOSTS) {
    if (ctx.signal.aborted) break;
    ctx.log(host);
    const frame = await mountProbeFrame({
      host,
      file: "vis-worker.html",
      parent: ctx.stages.subject.slot,
      signal: ctx.signal,
    });
    let result: WorkerResult | null;
    try {
      result = await awaitMessage<WorkerResult>(frame.port, "result", RUN_TIMEOUT_MS, ctx.signal, () =>
        frame.port.postMessage({ type: "run" }),
      );
    } finally {
      frame.unmount();
    }
    answered.push(result !== null);
    if (!result) {
      lines.push(`${host}: the frame gave no result in ${RUN_TIMEOUT_MS} ms`);
      continue;
    }
    const expected = result.worker.ok === expectWorks && result.wasm.ok === expectWorks;
    const violated = result.violations.length ? `; policy violations: ${[...new Set(result.violations)].join(", ")}` : "";
    lines.push(
      `${host}: worker ${word(result.worker)}, wasm ${word(result.wasm)}${violated}; ${expected ? "as expected" : "differs from the expected"} (${expectWorks ? "both run" : "both refused"})`,
    );
  }
  if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped", ...lines] };
  return { state: judgeWorkerWasm(answered), lines: lines.length ? lines : ["no host ran"] };
}

export const probe: ProbeModule = {
  id: "P11",
  run,
  timeoutMs: 40_000,
};
