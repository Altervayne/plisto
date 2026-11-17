/*
 * Runs probes and their card actions for the page and holds the results in memory only. One run at a time:
 * a probe owns the stages while it runs, and the next starts only after the previous one's cleanup settled
 * (or the shell reset the stages for it). A thrown error becomes an invalid result rather than a failure of
 * the page. Lines an action adds survive the card's next result until that probe runs again, and the actions
 * a probe offered stay on its card whatever the run's end.
 */

// -- Framework Imports --
import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

// -- Local Imports --
import { applyVerdict, createActionStore } from "./cardActions";
import type { ActionEntry } from "./cardActions";
import { CATALOG, runAllOrder } from "./catalog";
import { executeAction, executeProbe } from "./executeProbe";
import { PROBES } from "./registry";
import { createThemeCell } from "./themeCell";
import { useOwnerSteps } from "./useOwnerSteps";
import type { HeldView, PromptView } from "./useOwnerSteps";

// -- Type Imports --
import type { ActionVerdict, CardResult, ProbeContext, StageHandles, Theme } from "./types";

export interface ProbeRunner {
  results: ReadonlyMap<string, CardResult>;
  /** The latest progress line of the running probe. */
  live: string;
  running: string | null;
  actions: ReadonlyMap<string, ActionEntry[]>;
  prompt: PromptView | null;
  held: HeldView | null;
  /** A page-level line about the last run, such as a probe that did not clean up; empty when none. */
  notice: string;
  runOne(id: string): void;
  runAll(): void;
  stop(): void;
  /** Settles an `owner` result with the owner's Yes or No. */
  answer(id: string, yes: boolean): void;
  runAction(cardId: string, actionId: string): void;
  answerPrompt(choice: string): void;
  release(): void;
}

export function useProbeRunner(
  stages: RefObject<StageHandles | null>,
  theme: Theme,
  setTheme: (theme: Theme) => void,
  saveCaptures: boolean,
): ProbeRunner {
  const [results, setResults] = useState<ReadonlyMap<string, CardResult>>(new Map());
  const [live, setLive] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [actions, setActions] = useState<ReadonlyMap<string, ActionEntry[]>>(new Map());
  const [notice, setNotice] = useState("");
  const abort = useRef<AbortController | null>(null);
  // A probe's theme change counts at once; the stamp is set here too, so a capture cannot beat the page's effect.
  const cell = useRef(
    createThemeCell(theme, (next) => {
      document.documentElement.dataset.theme = next;
      setTheme(next);
    }),
  ).current;
  cell.adopt(theme);
  const saveRef = useRef(saveCaptures);
  saveRef.current = saveCaptures;
  const store = useRef(createActionStore(setActions)).current;
  // Lines actions added to each card, kept so a result written after them still shows them.
  const extra = useRef(new Map<string, string[]>());

  const put = useCallback((id: string, result: CardResult) => {
    setResults((prev) => new Map(prev).set(id, result));
  }, []);

  const appendLine = useCallback((id: string, line: string) => {
    extra.current.set(id, [...(extra.current.get(id) ?? []), line]);
    setResults((prev) => {
      const cur = prev.get(id) ?? { state: "not run" as const, lines: [] };
      return new Map(prev).set(id, { ...cur, lines: [...cur.lines, line] });
    });
  }, []);

  const verdictOn = useCallback((id: string, verdict: ActionVerdict) => {
    setResults((prev) => new Map(prev).set(id, applyVerdict(prev.get(id) ?? { state: "not run", lines: [] }, verdict)));
  }, []);

  const steps = useOwnerSteps(appendLine, verdictOn);

  const contextFor = useCallback(
    (id: string, signal: AbortSignal, handles: StageHandles): ProbeContext => ({
      signal,
      stages: handles,
      env: { dpr: window.devicePixelRatio, theme: cell.get() },
      saveCaptures: saveRef.current,
      log: setLive,
      setTheme: cell.set,
      ask: (text) => steps.ask(id, signal, text),
      askYesNo: (text) => steps.askYesNo(id, signal, text),
      offerActions: (list) => store.offer(id, list),
      hold: (request) => steps.hold(id, signal, request, handles, window.devicePixelRatio),
    }),
    [cell, store, steps],
  );

  // The shell's own reset: the stages empty and as they rest, and the theme back. Runs before every run and
  // action, and again for a probe whose cleanup did not finish.
  const resetFor = useCallback(
    (handles: StageHandles, restoreTheme: Theme) => () => {
      for (const s of [handles.reference, handles.subject]) {
        s.setIsolated(false);
        s.setBlend("");
        s.setDip(1);
        s.clearSlot();
        s.snapToGrid();
      }
      cell.set(restoreTheme);
    },
    [cell],
  );

  const runIds = useCallback(
    async (ids: string[]) => {
      const handles = stages.current;
      if (!handles || abort.current) return;
      const controller = new AbortController();
      abort.current = controller;
      setNotice("");
      for (const id of ids) {
        const probe = PROBES.get(id);
        if (!probe || controller.signal.aborted) continue;
        setRunning(id);
        setLive("");
        const reset = resetFor(handles, cell.get());
        await executeProbe(probe, controller.signal, {
          prepare: () => {
            extra.current.delete(id);
            store.clear(id);
            put(id, { state: "running", lines: [] });
            reset();
          },
          makeContext: (signal) => contextFor(id, signal, handles),
          put: (result) => put(id, result),
          extraLines: () => extra.current.get(id) ?? [],
          resetStages: reset,
          notice: setNotice,
        });
      }
      abort.current = null;
      setRunning(null);
      setLive("");
    },
    [stages, put, store, cell, contextFor, resetFor],
  );

  const runAction = useCallback(
    async (cardId: string, actionId: string) => {
      const handles = stages.current;
      if (!handles || abort.current) return;
      const entry = store.begin(cardId, actionId);
      if (!entry) return;
      const controller = new AbortController();
      abort.current = controller;
      setNotice("");
      setRunning(cardId);
      const reset = resetFor(handles, cell.get());
      await executeAction(entry.action.label, entry.action.run, controller.signal, {
        prepare: reset,
        makeContext: (signal) => contextFor(cardId, signal, handles),
        appendLine: (line) => appendLine(cardId, line),
        applyVerdict: (verdict) => {
          if (verdict.line) extra.current.set(cardId, [...(extra.current.get(cardId) ?? []), verdict.line]);
          verdictOn(cardId, verdict);
        },
        resetStages: reset,
        notice: setNotice,
      });
      store.finish(cardId, actionId);
      abort.current = null;
      setRunning(null);
    },
    [stages, appendLine, store, cell, contextFor, resetFor, verdictOn],
  );

  return {
    results,
    live,
    running,
    actions,
    prompt: steps.prompt,
    held: steps.held,
    notice,
    runOne: (id) => void runIds([id]),
    runAll: () => void runIds(runAllOrder(CATALOG).filter((id) => PROBES.has(id))),
    stop: () => abort.current?.abort(),
    answer: (id, yes) => {
      const lines = results.get(id)?.lines ?? [];
      put(id, { state: yes ? "pass" : "fail", lines: [...lines, `owner answered ${yes ? "yes" : "no"}`] });
    },
    runAction: (cardId, actionId) => void runAction(cardId, actionId),
    answerPrompt: steps.answerPrompt,
    release: steps.release,
  };
}
