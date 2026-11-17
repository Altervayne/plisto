/*
 * Shared types of the probes page: the catalog entry a card shows, the contract a probe module fills,
 * and the handles a probe gets to the two stages. A probe module lives in probes/ and exports `probe`.
 */

// -- Type Imports --
import type { Rect, Rgba } from "./pixelDiff";

/** A: runs now on a fixture. B: runs on a stand-in. C: needs the owner's eyes. X: not run on this page. */
export type ProbeKind = "A" | "B" | "C" | "A+C" | "X";

/** What a finished run reports. */
export type OutcomeState = "pass" | "fail" | "measured" | "invalid" | "owner";

/** Every state a card can show. */
export type ProbeState = OutcomeState | "not run" | "running" | "not built" | "not in V0" | "timed out" | "stopped";

export type Theme = "light" | "dark";

/** One probe's card text. `outOfV0` carries the reason a card that runs nothing gives. */
export interface CatalogEntry {
  id: string;
  title: string;
  kind: ProbeKind;
  what: string;
  pass: string;
  outOfV0?: string;
  /** True for a probe that never joins "Run all" and needs its own acknowledgement before every run. */
  manual?: boolean;
  /** The acknowledgement text of a manual probe, shown unless its module supplies its own. */
  warning?: string;
}

export interface ProbeOutcome {
  state: OutcomeState;
  lines: string[];
}

/** The two stages of the replica. A probe drives the subject and compares it against the reference. */
export interface StageHandle {
  /** The `.panel` element: the capture rectangle of the stage. */
  panel: HTMLElement;
  /** The slot the visualizer layer occupies; it carries the blend mode and the dip opacity. */
  slot: HTMLElement;
  setBlend(mode: string): void;
  setDip(opacity: number): void;
  /** Wraps the slot's ancestor chain in an isolated group: the negative control of the blend. */
  setIsolated(on: boolean): void;
  /** Moves the stage so its slot's top-left lies on a whole device pixel; call again after a layout change. */
  snapToGrid(): void;
  /** Removes everything a probe left in the slot; the stage itself puts nothing there. */
  clearSlot(): void;
  /** The ancestors between the slot and the panel that make a stacking context; empty when the stage is faithful. */
  stackingBreaks(): string[];
}

export interface StageHandles {
  reference: StageHandle;
  subject: StageHandle;
}

export interface PageEnv {
  dpr: number;
  theme: Theme;
}

export interface ProbeContext {
  signal: AbortSignal;
  stages: StageHandles;
  env: PageEnv;
  /** The page's "Save captures" setting; probes that take a capture pass it on to the capture command. */
  saveCaptures: boolean;
  /** A progress line shown on the card while the probe runs. */
  log(line: string): void;
  setTheme(theme: Theme): void;
  /**
   * Asks the owner one thing and resolves with the choice. Unanswered after PROMPT_TIMEOUT_MS, or when this
   * run's signal aborts, it resolves "skip".
   */
  ask(text: string): Promise<PromptAnswer>;
  /**
   * Asks the owner a question the card answers with Yes or No, with no time limit of its own. Resolves null
   * when this run's signal aborts (Stop or the deadline).
   */
  askYesNo(text: string): Promise<"yes" | "no" | null>;
  /** Replaces the named actions on this probe's card. An action already running or done keeps that state. */
  offerActions(actions: CardAction[]): void;
  /**
   * Draws the four registration marks around the two stages and accepts the owner's pasted screenshots until
   * released (by the card's Done button, or this signal aborting). Resolves when released.
   */
  hold(request: HoldRequest): Promise<void>;
}

export type PromptAnswer = "continue" | "skip";

/**
 * What an action may report about its card: a state and a line. The shell moves the card only toward
 * `fail` or `invalid`, never up to `pass`, whatever is returned; the line is always added.
 */
export interface ActionVerdict {
  state: ProbeState;
  line?: string;
}

/** A button on a probe's card. `run` starts when the owner clicks it, with a context of its own. */
export interface CardAction {
  id: string;
  label: string;
  run(ctx: ProbeContext): Promise<void | ActionVerdict>;
}

/** Where the stages sit inside the marked region, in CSS pixels from its top-left corner. */
export interface PastedLayout {
  region: { w: number; h: number };
  reference: Rect;
  subject: Rect;
}

/** An image the owner pasted while a case was held, with the layout its marks were drawn for. */
export interface PastedImage {
  image: Rgba;
  dpr: number;
  layout: PastedLayout;
}

export interface HoldRequest {
  /** What is held, shown on the card while it is. */
  label: string;
  /**
   * Called for each pasted image. A string becomes a line on the card and the report; an object also carries a
   * verdict, applied to the card at once under the down-only rule, whatever later ends the action.
   */
  onPaste(paste: PastedImage): Promise<string | PasteAnswer>;
}

export interface PasteAnswer {
  line: string;
  verdict?: ActionVerdict;
}

export interface ProbeModule {
  id: string;
  run(ctx: ProbeContext): Promise<ProbeOutcome>;
  /** Replaces the catalog's acknowledgement text for a risky probe. */
  warning?: string;
  /** Deadline of one run in ms; defaults to 60 s and is clamped. Past it the card reads "timed out". */
  timeoutMs?: number;
}

/** What the page holds per probe between runs. */
export interface CardResult {
  state: ProbeState;
  lines: string[];
}
