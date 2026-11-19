// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { VisualizerWarning } from "./VisualizerWarning";
import { WarningCard, type WarningChoice } from "./WarningCard";

// -- IPC Imports --
import { getSetting, setSetting } from "../../../../lib/ipc";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../../../../state/preferences/store";
import { parseCatalog, serializeCatalog } from "../../../../state/player/visualizerCatalog";
import { resetAcknowledgedHere, useSessionKind, useWarningSnapshots } from "../../../../state/player/visualizerWarning";

const h = vi.hoisted(() => ({
  ack: false,
  retried: false,
  setAck: vi.fn(),
  setRetried: vi.fn(),
  focus: vi.fn(),
  triggerFocus: vi.fn(),
  phase: "gate" as "gate" | "notice",
  locale: "en" as "en" | "fr",
}));

vi.mock("../../../../lib/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

// A static render reads a store's initial state; hooks read the live state instead.
vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});

// The components are called as plain functions: state hooks return fixed values and effects run at once.
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (initial: unknown) =>
      typeof initial === "function"
        ? [(initial as () => unknown)(), vi.fn()]
        : h.phase === "gate"
          ? [h.retried, h.setRetried]
          : [h.ack, h.setAck],
    useRef: () => ({ current: { focus: h.focus } }),
    useEffect: (fn: () => void) => void fn(),
    useLayoutEffect: () => undefined,
  };
});
vi.mock("../../../../i18n", async (orig) => {
  const real = await orig<typeof import("../../../../i18n")>();
  return { ...real, useT: () => real.createT(h.locale) };
});

const PLAYER_VIEW = import.meta.glob<string>("../../PlayerView.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
})["../../PlayerView.tsx"];

const ACK = PREF_KEYS.visualizerWarningAck;
const CATALOG = PREF_KEYS.playerVisualizerCatalog;
const REACT = PREF_KEYS.playerVisualizerReactivity;
const KIND = PREF_KEYS.playerVisualizer;

type Node = { type: unknown; props: Record<string, unknown> };

const prefs = () => usePreferencesStore.getState();
const seed = (values: Record<string, string>, failed: string[] = [], loaded = true) =>
  usePreferencesStore.setState({ values, failedKeys: new Set(failed), loaded });

function find(node: unknown, match: (n: Node) => boolean): Node | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== "object") return null;
  const el = node as Node;
  if (match(el)) return el;
  return find(el.props?.children, match);
}

/** The notice's card element, as the gate renders it. */
function noticeCard(): Node {
  const node = gate();
  if (!node) throw new Error("no notice");
  h.phase = "notice";
  return (node.type as (props: unknown) => unknown)(node.props) as Node;
}

/** The gate's output: null, or the notice element. */
function gate(): Node | null {
  h.phase = "gate";
  return VisualizerWarning({}) as unknown as Node | null;
}

const choice = (id: WarningChoice["id"]): WarningChoice =>
  (noticeCard().props.choices as WarningChoice[]).find((c) => c.id === id)!;

beforeEach(() => {
  vi.stubGlobal("document", { querySelector: vi.fn(() => ({ focus: h.triggerFocus })) });
  h.triggerFocus.mockReset();
  resetAcknowledgedHere();
  useSessionKind.setState({ kind: null });
  vi.mocked(getSetting).mockReset().mockResolvedValue(null);
  vi.mocked(setSetting).mockReset().mockResolvedValue(undefined);
  useWarningSnapshots.setState({ groups: null, reactivity: null, kind: null });
  h.ack = false;
  h.retried = false;
  h.locale = "en";
  h.setAck.mockReset();
  h.setRetried.mockReset();
  h.focus.mockReset();
  seed({});
});

describe("when the notice shows", () => {
  it("shows nothing while the preferences are still loading", () => {
    seed({}, [], false);
    expect(gate()).toBeNull();
  });

  it("shows nothing once acknowledged", () => {
    seed({ [ACK]: "1" });
    expect(gate()).toBeNull();
  });

  it("shows while pending", () => {
    expect(gate()).not.toBeNull();
  });

  it("re-reads an unreadable flag on mount and shows nothing until that read settles", () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    usePreferencesStore.setState({ retryPreference: retry });
    seed({}, [ACK]);
    expect(gate()).toBeNull();
    expect(retry).toHaveBeenCalledWith(ACK);
  });

  it("shows nothing when the re-read finds the flag acknowledged", async () => {
    vi.mocked(getSetting).mockResolvedValue("1");
    seed({}, [ACK]);
    await prefs().retryPreference(ACK);
    expect(gate()).toBeNull();
  });

  it("shows the notice when the re-read still fails", async () => {
    vi.mocked(getSetting).mockRejectedValue(new Error("down"));
    seed({}, [ACK]);
    const retry = prefs().retryPreference;
    usePreferencesStore.setState({ retryPreference: vi.fn(retry) });
    gate();
    await vi.waitFor(() => expect(h.setRetried).toHaveBeenCalledWith(true));
    h.retried = true;
    expect(prefs().failedKeys.has(ACK)).toBe(true);
    expect(gate()).not.toBeNull();
  });

  it("moves focus to the card", () => {
    noticeCard();
    expect(h.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("wording", () => {
  const html = () => renderToStaticMarkup(<>{noticeCard() as unknown as never}</>);

  it("keeps the settled wording after the switches write their keys", () => {
    seed({ [ACK]: "first", [REACT]: "calm", [PREF_KEYS.playerResume]: "{}" });
    expect(html()).toContain("Visualizers can flash");
    expect(html()).not.toContain("New visualizers can flash");
  });

  it("uses the first-time wording with no earlier use", () => {
    expect(html()).toContain("Visualizers can flash");
    expect(html()).not.toContain("New visualizers can flash");
  });

  it("uses the after-update wording once an earlier-use key is stored", () => {
    seed({ [ACK]: "update" });
    expect(html()).toContain("New visualizers can flash");
    expect(html()).toContain("This update adds the Cyber and Cosmic families");
  });

  it("speaks French", () => {
    h.locale = "fr";
    expect(html()).toContain("Les visualiseurs peuvent produire des flashs");
    expect(html()).toContain("Continuer");
  });
});

describe("the card", () => {
  const render = (ack: boolean, choices: WarningChoice[] = []) =>
    renderToStaticMarkup(
      <WarningCard kind="first" choices={choices} ack={ack} onAck={() => {}} onCarry={() => {}} />,
    );

  it("is a non-modal dialog named and described by its heading and body", () => {
    const html = render(false);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="visualizer-warning-title"');
    expect(html).toContain('aria-describedby="visualizer-warning-body"');
    expect(html).toContain('id="visualizer-warning-title"');
    expect(html).toContain('id="visualizer-warning-body"');
    expect(html).not.toContain("aria-modal");
  });

  it("has Carry on disabled until the box is ticked", () => {
    const off = render(false);
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Carry on<\/button>/);
    expect(off).toContain('role="checkbox" aria-checked="false"');
    const on = render(true);
    expect(on).not.toMatch(/disabled=""[^>]*>Carry on/);
    expect(on).toContain('role="checkbox" aria-checked="true"');
  });

  it("has no close control and no key or outside-press handler", () => {
    const card = WarningCard({
      kind: "first",
      choices: [],
      ack: false,
      onAck: () => {},
      onCarry: () => {},
    }) as unknown as Node;
    expect(card.props.onKeyDown).toBeUndefined();
    expect(card.props.onBlur).toBeUndefined();
    expect(card.props.tabIndex).toBe(-1);
    const closeLabel = (n: Node) =>
      typeof n.props?.["aria-label"] === "string" && /close|dismiss/i.test(n.props["aria-label"] as string);
    expect(find(card, closeLabel)).toBeNull();
    expect(render(false)).not.toMatch(/close|dismiss|remind/i);
  });

  it("points each switch at its hint line", () => {
    const choices = (["cozy", "calm", "off"] as const).map((id) => ({
      id,
      on: false,
      disabled: false,
      onChange: () => {},
    }));
    const html = render(false, choices);
    for (const id of ["cozy", "calm", "off"]) {
      expect(html).toContain(`aria-describedby="visualizer-warning-${id}"`);
      expect(html).toContain(`id="visualizer-warning-${id}"`);
    }
  });

  it("lists the three switches, then the box, then Carry on, in order", () => {
    const choices = (["cozy", "calm", "off"] as const).map((id) => ({
      id,
      on: false,
      disabled: false,
      onChange: () => {},
    }));
    const html = render(false, choices);
    const order = [
      'aria-label="Keep only Cozy"',
      'aria-label="Set Reactivity to Calm"',
      'aria-label="Turn visualizers off"',
      'role="checkbox"',
      ">Carry on<",
    ].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders a disabled choice as a disabled switch", () => {
    const html = render(false, [{ id: "calm", on: false, disabled: true, onChange: () => {} }]);
    expect(html).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
  });
});

describe("the switches", () => {
  it("reflect the stored values", () => {
    seed({
      [CATALOG]: serializeCatalog({ kinds: [], groups: ["classic", "dots", "fluid", "cyber", "cosmic"] }),
      [REACT]: "calm",
      [KIND]: "off",
    });
    expect(choice("cozy").on).toBe(true);
    expect(choice("calm").on).toBe(true);
    expect(choice("off").on).toBe(true);
  });

  it("start off with nothing stored", () => {
    expect(["cozy", "calm", "off"].map((id) => choice(id as WarningChoice["id"]).on)).toEqual([false, false, false]);
  });

  it("write on at once and restore on off", () => {
    seed({ [REACT]: "lively", [KIND]: "ink" });
    choice("calm").onChange(true);
    choice("off").onChange(true);
    expect(prefs().values[REACT]).toBe("calm");
    expect(prefs().values[KIND]).toBe("off");
    expect(choice("calm").on && choice("off").on).toBe(true);
    choice("calm").onChange(false);
    choice("off").onChange(false);
    expect(prefs().values[REACT]).toBe("lively");
    expect(prefs().values[KIND]).toBe("ink");
    expect(setSetting).toHaveBeenCalledWith(REACT, "calm");
  });

  it("restore a family turned off before the notice", () => {
    const before = serializeCatalog({ kinds: [], groups: ["dots"] });
    seed({ [CATALOG]: before });
    choice("cozy").onChange(true);
    expect(parseCatalog(prefs().values[CATALOG], false).state.groups).not.toContain("cozy");
    expect(choice("cozy").on).toBe(true);
    choice("cozy").onChange(false);
    expect(prefs().values[CATALOG]).toBe(before);
    expect(choice("cozy").on).toBe(false);
  });

  it("disable the reactivity and pick switches when their key is unreadable", () => {
    seed({}, [REACT, KIND]);
    expect(choice("calm").disabled).toBe(true);
    expect(choice("off").disabled).toBe(true);
    expect(choice("cozy").disabled).toBe(false);
  });

  it("disable Keep only Cozy when the catalog is unreadable", () => {
    seed({}, [CATALOG]);
    expect(choice("cozy").disabled).toBe(true);
    expect(choice("calm").disabled).toBe(false);
  });

  it("show the real state again on a remount, with the box unticked", () => {
    seed({ [REACT]: "calm" });
    expect(choice("calm").on).toBe(true);
    expect(noticeCard().props.ack).toBe(false);
    expect(choice("calm").on).toBe(true);
  });
});

describe("Carry on", () => {
  it("acknowledges only with the box ticked", () => {
    noticeCard();
    const unticked = noticeCard().props.onCarry as () => void;
    unticked();
    expect(prefs().values[ACK]).toBeUndefined();
    h.ack = true;
    const ticked = noticeCard().props.onCarry as () => void;
    ticked();
    expect(prefs().values[ACK]).toBe("1");
    expect(setSetting).toHaveBeenCalledWith(ACK, "1");
    expect(h.triggerFocus).toHaveBeenCalledTimes(1);
    expect(gate()).toBeNull();
  });

  it("drives the box through its setter", () => {
    (noticeCard().props.onAck as (next: boolean) => void)(true);
    expect(h.setAck).toHaveBeenCalledWith(true);
  });
});

describe("where it mounts", () => {
  it("is left out of ambient mode and the compact open-file window", () => {
    expect(PLAYER_VIEW).toContain("{ambient || compact ? null : <VisualizerWarning floorRef={seekRef} />}");
  });
});
