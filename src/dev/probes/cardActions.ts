/*
 * State of the actions a probe offers on its card. Each action is ready, running, or done; one that is
 * done stays done when the probe offers the list again, so a held case is used once.
 */

// -- Type Imports --
import type { ActionVerdict, CardAction, CardResult, PasteAnswer, ProbeState } from "./types";

// How bad a state reads: an action may raise it, never lower it.
const SEVERITY: Partial<Record<ProbeState, number>> = { fail: 1, invalid: 2 };

export interface ActionStore {
  get(id: string): ActionEntry[];
  /** Replaces a card's actions with a newly offered list. */
  offer(id: string, list: readonly CardAction[]): void;
  /** Empties a card's actions: a run of that probe starts. */
  clear(id: string): void;
  /** Marks an action running and returns it; null when it cannot start. */
  begin(id: string, actionId: string): ActionEntry | null;
  finish(id: string, actionId: string): void;
}

/** The actions of every card. `onChange` gets a fresh map after each change, for the page to render. */
export function createActionStore(onChange: (all: ReadonlyMap<string, ActionEntry[]>) => void): ActionStore {
  let all = new Map<string, ActionEntry[]>();
  const set = (id: string, entries: ActionEntry[]) => {
    all = new Map(all).set(id, entries);
    onChange(all);
  };
  return {
    get: (id) => all.get(id) ?? [],
    offer: (id, list) => set(id, offerEntries(list, all.get(id) ?? [])),
    clear: (id) => set(id, []),
    begin(id, actionId) {
      const next = beginAction(all.get(id) ?? [], actionId);
      if (!next) return null;
      set(id, next);
      return next.find((e) => e.action.id === actionId) ?? null;
    },
    finish: (id, actionId) => set(id, finishAction(all.get(id) ?? [], actionId)),
  };
}

/** Adds a paste's line to the card and applies its verdict, if any, at once; the verdict's own line is not repeated. */
export function deliverPaste(
  answer: string | PasteAnswer,
  appendLine: (line: string) => void,
  applyToCard: (verdict: ActionVerdict) => void,
): void {
  if (typeof answer === "string") return appendLine(answer);
  appendLine(answer.line);
  if (answer.verdict) applyToCard({ state: answer.verdict.state });
}

/** The card after an action's verdict: demoted to fail or invalid when that is worse, never upgraded. */
export function applyVerdict(card: CardResult, verdict: ActionVerdict): CardResult {
  const lines = verdict.line ? [...card.lines, verdict.line] : card.lines;
  const rise = (SEVERITY[verdict.state] ?? 0) > (SEVERITY[card.state] ?? 0);
  return { state: rise ? verdict.state : card.state, lines };
}

export type ActionStatus = "ready" | "running" | "done";

export interface ActionEntry {
  action: CardAction;
  status: ActionStatus;
}

/** The entries for a newly offered list; an id already running or done keeps that status. */
export function offerEntries(actions: readonly CardAction[], prior: readonly ActionEntry[]): ActionEntry[] {
  const before = new Map(prior.map((e) => [e.action.id, e.status]));
  const seen = new Set<string>();
  const out: ActionEntry[] = [];
  for (const action of actions) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    out.push({ action, status: before.get(action.id) ?? "ready" });
  }
  return out;
}

/** Whether the button for `id` can be pressed: it is ready and nothing else is running. */
export function canRunAction(entries: readonly ActionEntry[], id: string, busy: boolean): boolean {
  return !busy && entries.some((e) => e.action.id === id && e.status === "ready");
}

/** Marks `id` running; null when it cannot start. */
export function beginAction(entries: readonly ActionEntry[], id: string): ActionEntry[] | null {
  if (!canRunAction(entries, id, false)) return null;
  return entries.map((e) => (e.action.id === id ? { ...e, status: "running" as const } : e));
}

/** Marks `id` done, whatever way it ended. */
export function finishAction(entries: readonly ActionEntry[], id: string): ActionEntry[] {
  return entries.map((e) => (e.action.id === id ? { ...e, status: "done" as const } : e));
}
