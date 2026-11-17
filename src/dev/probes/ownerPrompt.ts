/*
 * One question to the owner during a run. It resolves with the owner's choice, or with a fallback when the
 * run's signal aborts, or when nobody answers in time if the question has a time limit. A Continue/Skip
 * prompt skips itself after PROMPT_TIMEOUT_MS so an unattended Run all never waits on it.
 */

// -- Type Imports --
import type { PromptAnswer } from "./types";

/** How long an unanswered Continue/Skip prompt waits before it skips itself. */
export const PROMPT_TIMEOUT_MS = 30_000;

/**
 * Resolves with the choice given to the function handed to `onReady`, else `fallback` on abort or, when
 * `timeoutMs` is finite, on timeout. Later answers are ignored.
 */
export function awaitChoice<T extends string | null>(
  signal: AbortSignal,
  fallback: T,
  onReady: (answer: (choice: T) => void) => void,
  timeoutMs = Infinity,
): Promise<T> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(fallback);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (choice: T) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(choice);
    };
    const onAbort = () => end(fallback);
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => end(fallback), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    onReady(end);
  });
}

/** The Continue/Skip prompt: skips on timeout or abort. */
export function awaitPrompt(
  signal: AbortSignal,
  onReady: (answer: (choice: PromptAnswer) => void) => void,
  timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<PromptAnswer> {
  return awaitChoice<PromptAnswer>(signal, "skip", onReady, timeoutMs);
}
