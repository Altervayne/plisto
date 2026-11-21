/*
 * The harness page. It reads the plugin's kinds from the mock server, mounts the chosen one in a sandboxed
 * frame on the real runtime, and ticks it from the chosen feed once per display frame through the credit
 * window. Controls map onto VisContext fields and reach the frame as `update` messages that carry only what
 * changed. Watch mode, when the server has it, reloads the page after the author's files change; the controls
 * survive a reload in localStorage.
 */

// -- Local Imports --
import { createAudioFeed } from "./audioFeed.js";
import { paintBackdrop } from "./backdrop.js";
import { buildControls, el } from "./controls.js";
import {
  LAYOUTS,
  PALETTE,
  REACTIVITIES,
  blendOf,
  buildContext,
  createContextTracker,
  defaultSettings,
  stageTheme,
} from "./context.js";
import { createRecordedFeed, createScriptedFeed, parseRecording, shapeTick } from "./feeds.js";
import { coverBitmap, openMount, stillOf } from "./mount.js";
import { createRun, record, summarize } from "./readout.js";
import { accepts } from "../lib/check/settings.mjs";

const $ = (id) => document.getElementById(id);
const READOUT_MS = 250;

// -- Stored controls --

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked; the controls then start fresh each load.
  }
}

/** The controls' state: stored values that still fit the manifest, defaults for the rest. */
function initialState(kinds, stored) {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const settings = {};
  for (const { decl } of kinds) {
    const own = (stored.settings ?? {})[decl.id] ?? {};
    settings[decl.id] = defaultSettings(decl);
    for (const s of decl.settings) {
      const value = accepts(s, own[s.id]);
      if (value !== undefined) settings[decl.id][s.id] = value;
    }
  }
  return {
    kind: pick(stored.kind, kinds.map((k) => k.decl.id), kinds[0].decl.id),
    theme: pick(stored.theme, ["dark", "light"], "dark"),
    layout: pick(stored.layout, Object.keys(LAYOUTS), "player"),
    reactivity: pick(stored.reactivity, REACTIVITIES, "balanced"),
    reducedMotion: flag(stored.reducedMotion, false),
    playing: flag(stored.playing, true),
    meter: flag(stored.meter, true),
    hidden: false,
    guides: flag(stored.guides, false),
    settings,
  };
}

// -- Page --

async function main() {
  const response = await fetch("/_plisto/harness.json");
  const config = response.ok ? await response.json() : null;
  if (!config) {
    $("status").textContent =
      "No visualizer plugin is served. Start with: node plugin-kit/sdk/mock-serve.mjs 8765 <plugin folder>";
    return;
  }
  if (!config.ok) {
    $("status").textContent = `The manifest is refused: ${config.refusal}`;
    if (config.watch) watchForChanges();
    return;
  }
  $("title").textContent = `${config.name ?? config.id ?? "Plugin"} - visualizer harness`;
  if (config.watch) watchForChanges();
  start(config);
}

function watchForChanges() {
  const events = new EventSource("/_plisto/watch");
  events.onmessage = () => location.reload();
}

function start(config) {
  const { kinds } = config;
  const storeKey = `plisto-vis-harness:${config.id ?? ""}`;
  const state = initialState(kinds, readStore(storeKey));
  const stage = $("stage");
  const backdrop = $("backdrop");
  const pointer = { x: 0.5, y: 0.5, inside: false };
  const slot = { inView: true };
  let mount = null;
  let run = createRun();
  let tracker = null;
  let cover = null;
  let feed = null;
  let audioFile = null;
  let generation = 0;
  let epoch = 0;
  let last = 0;
  let level = 0;

  const kindOf = () => kinds.find((k) => k.decl.id === state.kind);
  const needs = () => kindOf().decl.needs;
  const notice = (text) => {
    $("notice").textContent = text ?? "";
    $("notice").hidden = !text;
  };
  const contextNow = () =>
    buildContext(kindOf().decl, { ...state, settings: state.settings[state.kind] }, cover);
  const isVisible = () => document.visibilityState === "visible" && slot.inView && !state.hidden;

  // -- Stage --

  function drawOverlay() {
    const { layout } = LAYOUTS[state.layout];
    const box = (cls, [x, y, w, h], radius) => {
      const node = el("div", { class: cls });
      Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      if (radius !== undefined) node.style.borderRadius = `${radius}px`;
      return node;
    };
    const nodes = layout.hush.map((rect) => box("hush", rect));
    if (!kindOf().decl.fillsStage) nodes.push(box("cover", layout.cover, layout.radius));
    if (state.guides) {
      nodes.push(box("guide", layout.cover, layout.radius));
      if (layout.mask) nodes.push(box("guide", layout.mask));
      if (layout.floor !== null) nodes.push(box("guide floor", [0, layout.floor, layout.width, 0]));
    }
    $("overlay").replaceChildren(...nodes);
  }

  // The stage is scaled down to its panel so the page never scrolls sideways; pointer math uses the box.
  function fitStage(layout) {
    const scroller = stage.parentElement;
    const scale = Math.min(1, (scroller.clientWidth || layout.width) / layout.width);
    stage.style.transform = scale < 1 ? `scale(${scale})` : "";
    scroller.style.height = `${Math.ceil(layout.height * scale)}px`;
  }

  function applyStage() {
    const { layout } = LAYOUTS[state.layout];
    const decl = kindOf().decl;
    document.documentElement.dataset.theme = state.theme;
    stage.style.width = `${layout.width}px`;
    stage.style.height = `${layout.height}px`;
    fitStage(layout);
    if (backdrop.width !== layout.width) backdrop.width = layout.width;
    if (backdrop.height !== layout.height) backdrop.height = layout.height;
    if (mount) {
      Object.assign(mount.frame.style, {
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        mixBlendMode: blendOf(decl, state.theme),
      });
    }
    drawOverlay();
  }

  function pushContext() {
    if (!mount || !tracker) return;
    const changed = tracker.diff(contextNow());
    if (changed) mount.transport.post({ type: "update", context: changed });
  }

  // -- Mount and feed --

  async function mountKind() {
    const token = ++generation;
    mount?.close();
    mount = null;
    run = createRun();
    notice(null);
    const kind = kindOf();
    cover = kind.decl.needs.cover ? await coverBitmap() : null;
    if (token !== generation) return;
    const context = contextNow();
    tracker = createContextTracker(context);
    const mine = run;
    const opened = await openMount({
      kind,
      context,
      meter: state.meter,
      parent: stage,
      isVisible,
      onMessage: (message, now) => record(mine, message, now),
    });
    if (token !== generation) {
      opened.close();
      return;
    }
    mount = opened;
    run.startedAt = opened.startedAt;
    epoch = last = performance.now();
    applyStage();
  }

  async function setFeed(mode, file) {
    try {
      let next;
      if (mode === "scripted") next = createScriptedFeed(needs());
      else if (mode === "recorded") next = createRecordedFeed(parseRecording(JSON.parse(await file.text())));
      else {
        audioFile = file;
        next = await createAudioFeed(file, needs);
      }
      feed?.stop?.();
      feed = next;
      feed.setPlaying?.(state.playing);
      epoch = last = performance.now();
      notice(null);
    } catch (e) {
      notice(`That ${mode} feed could not be used: ${e.message}`);
    }
  }

  async function changeKind() {
    if (feed?.name === "scripted") await setFeed("scripted");
    else if (feed?.name === "approximate" && audioFile) await setFeed("audio", audioFile);
    await mountKind();
  }

  function change(key) {
    writeStore(storeKey, state);
    if (key === "kind") changeKind();
    else if (key === "playing") feed?.setPlaying?.(state.playing);
    else if (key === "meter") mount?.transport.post({ type: "meter", on: state.meter });
    else pushContext();
    applyStage();
  }

  async function showStill() {
    const result = await stillOf({ kind: kindOf(), context: contextNow(), parent: stage });
    $("still").hidden = !result.png;
    if (result.png) $("still-img").src = result.png;
    else notice(`No still: ${result.error}`);
  }

  // -- Display loop --

  function frameStep(now) {
    requestAnimationFrame(frameStep);
    const t = (now - epoch) / 1000;
    if (mount && feed) {
      const dt = Math.max(0, (now - last) / 1000);
      let tick = feed.next(t, dt);
      if (!feed.exact) tick = shapeTick(tick, state.reactivity);
      mount.transport.offer({
        ...tick,
        playing: state.playing,
        pointer: needs().pointer ? { ...pointer } : null,
      });
      level = tick.sig.level;
    }
    last = now;
    paintBackdrop(backdrop, { theme: stageTheme(kindOf().decl, state.theme), palette: PALETTE, t, level });
  }

  function drawReadout() {
    const idle = { sent: 0, acked: 0, outstanding: 0, withheld: 0, lastAckMs: null };
    const stats = mount ? mount.transport.stats() : idle;
    const rows = [{ label: "Feed", value: feed ? feed.name : "none" }, ...summarize(run, stats, state.meter)];
    const cells = ({ label, value, tone }) => [
      el("dt", { text: label }),
      el("dd", { text: value, "data-tone": tone ?? false }),
    ];
    $("readout").replaceChildren(...rows.flatMap(cells));
    $("log").textContent = run.log.join("\n");
    const phase = run.readyAt === null ? "Starting" : "Running";
    $("status").textContent = run.error ? "The kind reported an error" : phase;
  }

  // -- Wiring --

  stage.addEventListener("pointermove", (e) => {
    const rect = stage.getBoundingClientRect();
    pointer.x = (e.clientX - rect.left) / rect.width;
    pointer.y = (e.clientY - rect.top) / rect.height;
    pointer.inside = true;
  });
  stage.addEventListener("pointerleave", () => (pointer.inside = false));
  const seen = new IntersectionObserver((entries) => {
    slot.inView = entries[entries.length - 1].isIntersecting;
  });
  seen.observe(stage);
  new ResizeObserver(() => fitStage(LAYOUTS[state.layout].layout)).observe(stage.parentElement);
  $("still-close").addEventListener("click", () => ($("still").hidden = true));

  buildControls($("controls"), {
    kinds,
    state,
    change,
    actions: {
      feed: setFeed,
      restart: mountKind,
      still: showStill,
      settingsOf: (id) => state.settings[id],
      resetSettings: () => (state.settings[state.kind] = defaultSettings(kindOf().decl)),
    },
  });
  applyStage();
  setFeed("scripted").then(mountKind);
  requestAnimationFrame(frameStep);
  setInterval(drawReadout, READOUT_MS);
}

main();
