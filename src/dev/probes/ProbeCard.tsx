/*
 * One probe's card: what it measures, the pass line, its state and result lines, and the controls its
 * module needs. A card whose module does not exist reads "not built"; one the page never runs reads
 * "not in V0" with its reason.
 */

// -- Framework Imports --
import { useState } from "react";

// -- Local Imports --
import { canRunAction } from "./cardActions";
import type { ActionEntry } from "./cardActions";
import { cardState, runDisabled } from "./catalog";

// -- Type Imports --
import type { HeldView, PromptView } from "./useOwnerSteps";
import type { CardResult, CatalogEntry, ProbeModule } from "./types";

// -- Style Imports --
import styles from "./ProbeCard.module.css";

interface ProbeCardProps {
  entry: CatalogEntry;
  module: ProbeModule | undefined;
  result: CardResult | undefined;
  /** The live progress line while this probe runs. */
  live: string;
  /** Another probe is running. */
  busy: boolean;
  actions: readonly ActionEntry[];
  /** The owner prompt of this card's probe, if one is open. */
  prompt: PromptView | null;
  /** The case this card's probe holds for a screenshot, if any. */
  held: HeldView | null;
  onRun(): void;
  onAnswer(yes: boolean): void;
  onAction(actionId: string): void;
  onPrompt(choice: string): void;
  onRelease(): void;
}

export function ProbeCard({
  entry,
  module,
  result,
  live,
  busy,
  actions,
  prompt,
  held,
  onRun,
  onAnswer,
  onAction,
  onPrompt,
  onRelease,
}: ProbeCardProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const state = cardState(entry, !!module, result);
  const warning = module ? (module.warning ?? (entry.manual ? entry.warning : undefined)) : undefined;
  const disabled = runDisabled(entry, !!module, !!module?.warning, acknowledged, busy);

  return (
    <section className={styles.card} data-state={state.replace(/\s+/g, "-")}>
      <header className={styles.head}>
        <span className={styles.id}>{entry.id}</span>
        <h3 className={styles.title}>{entry.title}</h3>
        <span className={styles.kind}>{entry.kind}</span>
        <span className={styles.state}>{state}</span>
      </header>
      <p className={styles.text}>{entry.what}</p>
      <p className={styles.pass}>Pass: {entry.pass}</p>
      {entry.outOfV0 ? <p className={styles.reason}>{entry.outOfV0}</p> : null}
      {warning ? (
        <label className={styles.warning}>
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          <span>I understand. {warning}</span>
        </label>
      ) : null}
      {entry.kind !== "X" ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={disabled}
            onClick={() => {
              setAcknowledged(false);
              onRun();
            }}
          >
            Run
          </button>
          {state === "owner" ? (
            <>
              <button type="button" className={styles.button} onClick={() => onAnswer(true)}>
                Yes
              </button>
              <button type="button" className={styles.button} onClick={() => onAnswer(false)}>
                No
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {actions.length > 0 ? (
        <div className={styles.actions}>
          {actions.map((e) => (
            <button
              key={e.action.id}
              type="button"
              className={styles.button}
              disabled={!canRunAction(actions, e.action.id, busy)}
              onClick={() => onAction(e.action.id)}
            >
              {e.action.label}
            </button>
          ))}
        </div>
      ) : null}
      {held ? (
        <div className={styles.owner}>
          <p className={styles.lines}>
            Holding {held.label}. Take a window snip (Win+Shift+S), click this page, press Ctrl+V. Leave the window
            as it is.
          </p>
          <button type="button" className={styles.button} onClick={onRelease}>
            Done
          </button>
        </div>
      ) : null}
      {prompt ? (
        <div className={styles.owner}>
          <p className={styles.lines}>
            {prompt.text}
            {prompt.skipSecs === null ? "" : ` Skips itself after ${prompt.skipSecs} s.`}
          </p>
          <div className={styles.actions}>
            {prompt.choices.map((choice) => (
              <button key={choice} type="button" className={styles.button} onClick={() => onPrompt(choice)}>
                {choice.charAt(0).toUpperCase() + choice.slice(1)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {state === "running" && live ? <p className={styles.lines}>{live}</p> : null}
      {result && state !== "running" ? (
        <ul className={styles.results}>
          {result.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
