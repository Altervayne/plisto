/*
 * The owner's part of a run: one prompt at a time with Continue and Skip, and the held case whose
 * registration marks are drawn while the owner takes a screenshot and pastes it. A paste is read in memory,
 * handed to the probe that holds the case, and its answer becomes a line on that probe's card.
 */

// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Local Imports --
import { placeMarks } from "./hold";
import { awaitChoice, awaitPrompt, PROMPT_TIMEOUT_MS } from "./ownerPrompt";
import { handlePaste } from "./pasteFlow";
import { itemFile, itemTypes, readPastedImage } from "./pasteImage";

// -- Type Imports --
import type { Rect } from "./pixelDiff";
import type { ActionVerdict, HoldRequest, PastedLayout, PromptAnswer, StageHandles } from "./types";

export interface PromptView {
  id: string;
  text: string;
  /** The buttons, in order. */
  choices: readonly string[];
  /** Seconds before the prompt skips itself; null when it waits for as long as the run lasts. */
  skipSecs: number | null;
}

export interface HeldView {
  id: string;
  label: string;
  /** The registration marks in viewport CSS pixels, following the page as it scrolls. */
  marks: Rect[];
}

export interface OwnerSteps {
  prompt: PromptView | null;
  held: HeldView | null;
  answerPrompt(choice: string): void;
  /** Ends the held case. */
  release(): void;
  ask(id: string, signal: AbortSignal, text: string): Promise<PromptAnswer>;
  askYesNo(id: string, signal: AbortSignal, text: string): Promise<"yes" | "no" | null>;
  hold(id: string, signal: AbortSignal, request: HoldRequest, stages: StageHandles, dpr: number): Promise<void>;
}

interface Holding {
  id: string;
  request: HoldRequest;
  layout: PastedLayout;
  dpr: number;
  end(): void;
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function useOwnerSteps(
  appendLine: (id: string, line: string) => void,
  applyVerdictTo: (id: string, verdict: ActionVerdict) => void,
): OwnerSteps {
  const [prompt, setPrompt] = useState<PromptView | null>(null);
  const [held, setHeld] = useState<HeldView | null>(null);
  const answer = useRef<((choice: string) => void) | null>(null);
  const holding = useRef<Holding | null>(null);
  // The card a stray paste is reported on when nothing is held.
  const lastCard = useRef<string | null>(null);
  const append = useRef(appendLine);
  append.current = appendLine;
  const verdictTo = useRef(applyVerdictTo);
  verdictTo.current = applyVerdictTo;

  const ask = useCallback((id: string, signal: AbortSignal, text: string) => {
    lastCard.current = id;
    return awaitPrompt(signal, (choose) => {
      answer.current = (choice) => choose(choice === "continue" ? "continue" : "skip");
      setPrompt({ id, text, choices: ["continue", "skip"], skipSecs: PROMPT_TIMEOUT_MS / 1000 });
    }).finally(() => {
      answer.current = null;
      setPrompt(null);
    });
  }, []);

  const askYesNo = useCallback((id: string, signal: AbortSignal, text: string) => {
    lastCard.current = id;
    return awaitChoice<"yes" | "no" | null>(signal, null, (choose) => {
      answer.current = (choice) => choose(choice === "yes" ? "yes" : "no");
      setPrompt({ id, text, choices: ["yes", "no"], skipSecs: null });
    }).finally(() => {
      answer.current = null;
      setPrompt(null);
    });
  }, []);

  const hold = useCallback(
    (id: string, signal: AbortSignal, request: HoldRequest, stages: StageHandles, dpr: number) =>
      new Promise<void>((resolve) => {
        holding.current?.end();
        const measure = () => placeMarks(rectOf(stages.reference.slot), rectOf(stages.subject.slot), dpr);
        const placement = measure();
        const follow = () => setHeld((h) => (h ? { ...h, marks: measure().marks } : h));
        const end = () => {
          if (holding.current?.end !== end) return;
          holding.current = null;
          setHeld(null);
          signal.removeEventListener("abort", end);
          window.removeEventListener("scroll", follow, true);
          window.removeEventListener("resize", follow);
          resolve();
        };
        holding.current = { id, request, layout: placement.layout, dpr, end };
        lastCard.current = id;
        setHeld({ id, label: request.label, marks: placement.marks });
        window.addEventListener("scroll", follow, true);
        window.addEventListener("resize", follow);
        if (signal.aborted) end();
        else signal.addEventListener("abort", end, { once: true });
      }),
    [],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      const handling = handlePaste(
        holding.current,
        lastCard.current,
        itemTypes(data),
        (index) => (data ? itemFile(data, index) : null),
        {
          read: readPastedImage,
          appendLine: (id, line) => append.current(id, line),
          applyVerdict: (id, verdict) => verdictTo.current(id, verdict),
        },
      );
      if (handling.handled) e.preventDefault();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  return {
    prompt,
    held,
    answerPrompt: (choice) => answer.current?.(choice),
    release: () => holding.current?.end(),
    ask,
    askYesNo,
    hold,
  };
}
