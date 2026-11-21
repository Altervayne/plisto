/*
 * The harness's control panel. It edits one shared state object and says which key changed; what to do about
 * it (an update message, a remount, a new feed) is the caller's. The kind's own settings and presets are
 * drawn from its declaration and kept per kind.
 */

// -- Local Imports --
import { LAYOUTS, REACTIVITIES } from "./context.js";

/** Builds an element with attributes and children (strings or nodes). */
export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value !== null) node.setAttribute(key, String(value));
  }
  node.append(...kids);
  return node;
}

const cap = (word) => word[0].toUpperCase() + word.slice(1);

function segmented(label, options, value, pick) {
  const group = el("div", { class: "seg", role: "group", "aria-label": label });
  const buttons = options.map(([id, text]) => {
    const button = el("button", { type: "button", text, "aria-pressed": String(id === value) });
    button.addEventListener("click", () => {
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
      pick(id);
    });
    return button;
  });
  group.append(...buttons);
  return el("div", { class: "row" }, el("span", { text: label }), group);
}

function checkbox(label, checked, set) {
  const input = el("input", { type: "checkbox", checked });
  input.addEventListener("change", () => set(input.checked));
  return el("label", { class: "row" }, el("span", { text: label }), input);
}

function select(label, options, value, pick) {
  const input = el("select", { "aria-label": label });
  for (const [id, text] of options) input.append(el("option", { value: id, text, selected: id === value }));
  input.addEventListener("change", () => pick(input.value));
  return el("label", { class: "row" }, el("span", { text: label }), input);
}

function settingControl(setting, value, set) {
  const { id, label, type } = setting;
  if (type === "choice") return select(label, setting.options.map((o) => [o.id, o.label]), value, set);
  if (type === "toggle") return checkbox(label, value, set);
  if (type === "range") {
    const input = el("input", { type: "range", min: setting.min, max: setting.max, step: setting.step });
    input.value = String(value);
    const shown = el("output", { text: String(value) });
    input.addEventListener("input", () => {
      shown.textContent = input.value;
      set(Number(input.value));
    });
    return el("label", { class: "row" }, el("span", { text: label }), input, shown);
  }
  const useCover = el("input", {
    type: "checkbox",
    checked: value === "cover",
    "aria-label": `${label}: the cover`,
  });
  const color = el("input", { type: "color", "aria-label": label });
  color.value = value === "cover" ? "#3a6ea5" : value;
  color.disabled = value === "cover";
  const push = () => set(useCover.checked ? "cover" : color.value);
  useCover.addEventListener("change", () => {
    color.disabled = useCover.checked;
    push();
  });
  color.addEventListener("input", push);
  const cover = el("span", {}, "cover ", useCover);
  return el("div", { class: "row", "data-setting": id }, el("span", { text: label }), cover, color);
}

/**
 * Fills `form` with the controls. `state` is edited in place; `change(key)` follows each edit. `actions`:
 * `feed(mode, file)`, `restart()`, `still()`, `settingsOf(kindId)` and `resetSettings()`.
 */
export function buildControls(form, { kinds, state, change, actions }) {
  const kindOf = () => kinds.find((k) => k.decl.id === state.kind) ?? kinds[0];
  const set = (key) => (value) => {
    state[key] = value;
    change(key);
  };

  const feedFile = el("input", { type: "file", "aria-label": "Feed file", hidden: true });
  const feedNote = el("p", { class: "status", hidden: true });
  let mode = "scripted";
  const feedPick = select(
    "Feed",
    [["scripted", "Scripted"], ["recorded", "Recorded ticks"], ["audio", "Audio file (approximate)"]],
    mode,
    (value) => {
      mode = value;
      feedFile.hidden = mode === "scripted";
      feedFile.accept = mode === "recorded" ? ".json,application/json" : "audio/*";
      feedNote.hidden = mode !== "audio";
      feedNote.textContent = "Approximate: analysed in this page, not by Plisto's engine.";
      if (mode === "scripted") actions.feed("scripted");
    },
  );
  feedFile.addEventListener("change", () => feedFile.files[0] && actions.feed(mode, feedFile.files[0]));

  const settingsBox = el("fieldset", {}, el("legend", { text: "Kind settings" }));
  const drawSettings = () => {
    const { decl } = kindOf();
    settingsBox.replaceChildren(el("legend", { text: "Kind settings" }));
    settingsBox.hidden = decl.settings.length === 0;
    const values = actions.settingsOf(decl.id);
    for (const s of decl.settings) {
      settingsBox.append(
        settingControl(s, values[s.id], (value) => {
          values[s.id] = value;
          change("settings");
        }),
      );
    }
    const buttons = el("div", { class: "buttons" });
    for (const preset of decl.presets) {
      const b = el("button", { type: "button", text: preset.label });
      b.addEventListener("click", () => {
        Object.assign(values, preset.values);
        drawSettings();
        change("settings");
      });
      buttons.append(b);
    }
    const reset = el("button", { type: "button", text: "Reset settings" });
    reset.addEventListener("click", () => {
      actions.resetSettings();
      drawSettings();
      change("settings");
    });
    buttons.append(reset);
    settingsBox.append(buttons);
  };

  const run = el("div", { class: "buttons" });
  const restart = el("button", { type: "button", text: "Restart the kind" });
  restart.addEventListener("click", () => actions.restart());
  const still = el("button", { type: "button", text: "Show the still" });
  still.addEventListener("click", () => actions.still());
  run.append(restart, still);

  const kindPick =
    kinds.length > 1
      ? select("Kind", kinds.map((k) => [k.decl.id, k.decl.name]), state.kind, (value) => {
          state.kind = value;
          drawSettings();
          change("kind");
        })
      : null;

  form.replaceChildren(
    el(
      "fieldset",
      {},
      el("legend", { text: "Kind and feed" }),
      ...(kindPick ? [kindPick] : []),
      feedPick,
      feedFile,
      feedNote,
      checkbox("Playing", state.playing, set("playing")),
      run,
    ),
    el(
      "fieldset",
      {},
      el("legend", { text: "Context" }),
      segmented("Theme", [["dark", "Dark"], ["light", "Light"]], state.theme, set("theme")),
      segmented("Reactivity", REACTIVITIES.map((r) => [r, cap(r)]), state.reactivity, set("reactivity")),
      select("Layout", Object.entries(LAYOUTS).map(([id, l]) => [id, l.label]), state.layout, set("layout")),
      checkbox("Reduced motion", state.reducedMotion, set("reducedMotion")),
    ),
    el(
      "fieldset",
      {},
      el("legend", { text: "Harness" }),
      checkbox("Flash meter", state.meter, set("meter")),
      checkbox("Simulate a hidden slot", state.hidden, set("hidden")),
      checkbox("Show layout guides", state.guides, set("guides")),
    ),
    settingsBox,
  );
  drawSettings();
}
