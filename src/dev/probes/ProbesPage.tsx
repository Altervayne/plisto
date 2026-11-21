/*
 * The probes page: a dev-only developer tool that measures how a sandboxed visualizer frame behaves in
 * the player's stage. It replaces the app in the main window (?window=probes), so it carries no i18n and
 * keeps every result in memory. A probe is one file in probes/; this page lists the whole catalog.
 */

// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// -- Library Imports --
import { getVersion } from "@tauri-apps/api/app";

// -- Component Imports --
import { ProbeCard } from "./ProbeCard";
import { ProbeStage } from "./ProbeStage";

// -- Type Imports --
import type { ActionEntry } from "./cardActions";

// -- Hook Imports --
import { useProbeRunner } from "./useProbeRunner";

// -- Utils Imports --
import { CATALOG } from "./catalog";
import { copyToClipboard } from "../../lib/clipboard";
import { probeProcesses } from "./ipc";
import { glRendererString, measureDisplayHz } from "./pageEnv";
import { PROBES } from "./registry";
import { buildReport } from "./report";
import { snapCss } from "./stage";
import { isDarkTheme } from "../../theme";

// -- Type Imports --
import type { StageHandle, StageHandles, Theme } from "./types";

// -- Style Imports --
import styles from "./ProbesPage.module.css";

// The stage replica's size in CSS pixels, before snapping to whole device pixels.
const STAGE_W = 480;
const STAGE_H = 270;

const BUILT = new Set(PROBES.keys());
const NO_ACTIONS: ActionEntry[] = [];

export default function ProbesPage() {
  const [theme, setTheme] = useState<Theme>(() => (isDarkTheme() ? "dark" : "light"));
  const [version, setVersion] = useState("unknown");
  const [webview2, setWebview2] = useState("unknown");
  const [displayHz, setDisplayHz] = useState<number | null>(null);
  const [gl] = useState(glRendererString);
  const [stageNotes, setStageNotes] = useState<string[] | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const referenceRef = useRef<StageHandle>(null);
  const subjectRef = useRef<StageHandle>(null);
  const stagesRef = useRef<StageHandles | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [dpr, setDpr] = useState(window.devicePixelRatio);
  const [saveCaptures, setSaveCaptures] = useState(false);

  const runner = useProbeRunner(stagesRef, theme, setTheme, saveCaptures);

  // A zoom or a move to another display changes the pixel ratio and fires a resize.
  useEffect(() => {
    const onResize = () => setDpr(window.devicePixelRatio);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The stages are sticky, so their offset from the grid depends on the scroll position too.
  const snapStages = () => {
    stagesRef.current?.reference.snapToGrid();
    stagesRef.current?.subject.snapToGrid();
  };

  // The header and the facts line change height as readings arrive, which moves the stages.
  useLayoutEffect(snapStages, [dpr, version, webview2, displayHz, runner.notice]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const reference = referenceRef.current;
    const subject = subjectRef.current;
    if (!reference || !subject) return;
    stagesRef.current = { reference, subject };
    setStageNotes([...subject.stackingBreaks(), ...reference.stackingBreaks()]);
  }, []);

  useEffect(() => {
    getVersion().then(setVersion, () => {});
    probeProcesses().then((p) => setWebview2(p.browser_version), () => {});
    void measureDisplayHz().then(setDisplayHz);
  }, []);

  useEffect(() => {
    if (fallback !== null) fallbackRef.current?.select();
  }, [fallback]);

  const copyResults = async () => {
    const text = buildReport(
      { version, webview2, dpr, displayHz, gl, theme },
      CATALOG,
      runner.results,
      BUILT,
    );
    const ok = await copyToClipboard(text);
    setFallback(ok ? null : text);
    setCopied(ok);
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const width = snapCss(STAGE_W, dpr);
  const height = snapCss(STAGE_H, dpr);
  const busy = runner.running !== null;

  return (
    <div className={styles.page} onScroll={snapStages}>
      <header className={styles.header}>
        <h1 className={styles.title}>Visualizer probes</h1>
        <div className={styles.buttons}>
          <button type="button" className={styles.button} disabled={busy} onClick={runner.runAll}>
            Run all
          </button>
          <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={!busy} onClick={runner.stop}>
            Stop
          </button>
          <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={copyResults}>
            {copied ? "Copied" : "Copy results"}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.quiet}`}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            Theme: {theme}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.quiet}`}
            onClick={() => {
              location.search = "";
            }}
          >
            Back to Plisto
          </button>
        </div>
        <label className={styles.save}>
          <input type="checkbox" checked={saveCaptures} onChange={(e) => setSaveCaptures(e.target.checked)} />
          <span>Save captures to %TEMP%\plisto-probes\</span>
        </label>
      </header>
      {runner.notice ? <p className={styles.notice}>{runner.notice}</p> : null}
      <p className={styles.facts}>
        build {version} | webview2 {webview2} | dpr {dpr} | display {displayHz == null ? "unknown" : `${Math.round(displayHz)} Hz`} |
        gl "{gl}" | theme {theme}
      </p>

      <div className={styles.dock}>
        <div className={styles.stages}>
          <ProbeStage ref={referenceRef} label="Reference" width={width} height={height} theme={theme} />
          <ProbeStage ref={subjectRef} label="Subject" width={width} height={height} theme={theme} />
        </div>
      </div>
      <p className={styles.check}>
        {stageNotes === null
          ? "Stage check pending."
          : stageNotes.length === 0
            ? "Stage check: nothing between slot and panel forms a stacking context."
            : `Stage check found stacking contexts between slot and panel: ${stageNotes.join("; ")}`}
      </p>

      <div className={styles.cards}>
        {CATALOG.map((entry) => (
          <ProbeCard
            key={entry.id}
            entry={entry}
            module={PROBES.get(entry.id)}
            result={runner.results.get(entry.id)}
            live={runner.running === entry.id ? runner.live : ""}
            busy={busy}
            actions={runner.actions.get(entry.id) ?? NO_ACTIONS}
            prompt={runner.prompt?.id === entry.id ? runner.prompt : null}
            held={runner.held?.id === entry.id ? runner.held : null}
            onRun={() => runner.runOne(entry.id)}
            onAnswer={(yes) => runner.answer(entry.id, yes)}
            onAction={(actionId) => runner.runAction(entry.id, actionId)}
            onPrompt={runner.answerPrompt}
            onRelease={runner.release}
          />
        ))}
      </div>

      {runner.held?.marks.map((m, i) => (
        <div key={i} className={styles.mark} style={{ left: m.x, top: m.y, width: m.w, height: m.h }} />
      ))}

      {fallback !== null ? (
        <textarea ref={fallbackRef} className={styles.fallback} readOnly value={fallback} aria-label="Results" />
      ) : null}
    </div>
  );
}
