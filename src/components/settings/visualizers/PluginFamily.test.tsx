// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { TextLink } from "../../plugins/TextLink";
import {
  ID,
  decls,
  SAFE,
  buttons,
  familyOf,
  familyTree,
  html,
  mixed,
  only,
  ops,
  switches,
} from "./familyTestKit";
import { manifest } from "../../../state/plugins/fixtures";

// -- State Imports --
import { usePluginsStore } from "../../../state/plugins/store";
import { usePreferencesStore } from "../../../state/preferences/store";

// -- i18n Imports --
import { en } from "../../../i18n/en";

vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});
vi.mock("../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => false }));

beforeEach(() => {
  vi.clearAllMocks();
  usePluginsStore.setState({ rows: [] });
  usePreferencesStore.setState({ values: {}, failedKeys: new Set(), loaded: true });
});

describe("a plugin family's heading row", () => {
  it("reads on with the count, the Plugin tag, the Not checked mark and its tiles", () => {
    const out = html({ row: only() });
    expect(out).toContain("Pulse Lab");
    expect(out).toContain(en.plugins.vis.tag);
    expect(out).toContain(en.plugins.vis.notChecked);
    expect(out).toContain("2 of 2 on");
    expect(out).toContain(en.plugins.vis.notCheckedLine);
    expect(out).toContain("Rings");
  });

  it("keeps the Not checked mark and the line on every state that lists tiles", () => {
    for (const setup of [
      { row: only({ enabled: false }) },
      { row: only(), boot: SAFE },
      { row: only(), crash: true },
      { row: mixed({ enabled: false }) },
    ]) {
      const out = html(setup);
      expect(out).toContain(en.plugins.vis.notChecked);
      expect(out).toContain(en.plugins.vis.notCheckedLine);
    }
  });

  it("reads off with the plugins list's own word, and the tiles cannot be flipped", () => {
    const { tree } = familyTree({ row: only({ enabled: false }) });
    expect(html({ row: only({ enabled: false }) })).toContain(en.plugins.statusOff);
    expect(switches(tree)[0].props.checked).toBe(false);
  });

  it("reads review with Review in place of the switch", () => {
    const setup = { row: only({ state: "needs_consent", enabled: false }) };
    const { tree, ops: o } = familyTree(setup);
    expect(html(setup)).toContain(en.plugins.statusNeedsConsent);
    expect(switches(tree)).toHaveLength(0);
    const review = buttons(tree)[0];
    expect(review.props.children).toBe(en.plugins.review);
    (review.props.onClick as () => void)();
    expect(o.review).toHaveBeenCalledTimes(1);
  });

  it("reads newer with the version it needs, a locked switch and a dimmed name", () => {
    const newer = only({
      state: "incompatible",
      manifest: manifest({
        name: "Pulse Lab",
        entry: null,
        listing: "catalog",
        visualizers: decls,
        compat: { state: "needs_newer", min_plisto: "2.9.0" },
      }),
    });
    const { tree } = familyTree({ row: newer });
    expect(html({ row: newer })).toContain("Needs Plisto 2.9.0 or newer. You have 2.8.0.");
    expect(switches(tree)[0].props.disabled).toBe(true);
  });

  it("reads broken with its reason and Uninstall, no chevron and no tiles", () => {
    const setup = { row: only({ state: "broken", problem: "missing file: a.js", enabled: false }) };
    const out = html(setup);
    expect(out).toContain("Broken: missing file: a.js");
    expect(out).not.toContain(en.plugins.details);
    expect(out).not.toContain("Rings");
    const { tree, ops: o } = familyTree(setup);
    const uninstall = buttons(tree)[0];
    expect(uninstall.props.children).toBe(en.plugins.uninstall);
    (uninstall.props.onClick as () => void)();
    expect(o.uninstall).toHaveBeenCalledTimes(1);
  });

  it("reads a crash loop with Restart replacing the switch", () => {
    const { tree } = familyTree({ row: only({ enabled: false }), crash: true });
    expect(html({ row: only({ enabled: false }), crash: true })).toContain(en.plugins.status.hubCrashLoop);
    expect(switches(tree)).toHaveLength(0);
    expect(buttons(tree)[0].props.children).toBe(en.plugins.frame.restart);
  });

  it("reads safe mode with the live switch and the way out", () => {
    const setup = { row: only(), boot: SAFE };
    const { tree, ops: o } = familyTree(setup);
    expect(html(setup)).toContain(en.plugins.statusSafe);
    expect(switches(tree)[0].props.disabled).toBe(false);
    const link = tree.find((e) => e.type === TextLink)!;
    (link.props.onClick as () => void)();
    expect(o.restartNormally).toHaveBeenCalledTimes(1);
  });

  it("reads off in Plugins for a plugin with a page: a link and a locked, unchecked switch", () => {
    const setup = { row: mixed({ enabled: false }) };
    const { tree } = familyTree(setup);
    expect(html(setup)).toContain(en.plugins.vis.offInPlugins);
    expect(html(setup)).toContain(en.plugins.vis.openInPlugins);
    expect(switches(tree)[0].props.checked).toBe(false);
    expect(switches(tree)[0].props.disabled).toBe(true);
  });

  it("shows a mixed plugin in review as a link with a locked switch and no Review button", () => {
    const setup = { row: mixed({ state: "needs_consent", enabled: false }) };
    const { tree } = familyTree(setup);
    expect(html(setup)).toContain(en.plugins.statusNeedsConsent);
    expect(html(setup)).toContain(en.plugins.vis.openInPlugins);
    expect(buttons(tree)).toHaveLength(0);
    expect(switches(tree)[0].props.disabled).toBe(true);
  });
});

describe("a plugin family's switch", () => {
  it("turns a visualizer-only plugin on or off through its enabled state", () => {
    const { tree, ops: o } = familyTree({ row: only() });
    (switches(tree)[0].props.onChange as (v: boolean) => void)(false);
    expect(o.setEnabled).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), false);
  });

  it("writes the catalog flag for a plugin with its own page", () => {
    const { tree, onChange, ops: o } = familyTree({ row: mixed() });
    (switches(tree)[0].props.onChange as (v: boolean) => void)(false);
    expect(o.setEnabled).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ kinds: [], groups: [`plugin:${ID}`] });
  });
});

describe("a stored off flag on a visualizer-only family", () => {
  const flag = [`plugin:${ID}`];

  it("reads off after Keep only another family, with dimmed tiles that cannot be flipped", () => {
    const keepOnly = ["classic", "dots", ...flag];
    const { tree } = familyTree({ row: only() }, keepOnly);
    expect(switches(tree)[0].props.checked).toBe(false);
    const { family } = familyOf({ row: only() }, keepOnly);
    expect(family.plugin!.view.status).toBe("off");
  });

  it("clears the flag when the switch is turned on, without re-enabling an enabled plugin", () => {
    const { tree, onChange, ops: o } = familyTree({ row: only() }, ["classic", ...flag]);
    (switches(tree)[0].props.onChange as (v: boolean) => void)(true);
    expect(onChange).toHaveBeenCalledWith({ kinds: [], groups: ["classic"] });
    expect(o.setEnabled).not.toHaveBeenCalled();
  });

  it("also enables a plugin that is off", () => {
    const { tree, onChange, ops: o } = familyTree({ row: only({ enabled: false }) }, flag);
    (switches(tree)[0].props.onChange as (v: boolean) => void)(true);
    expect(onChange).toHaveBeenCalledWith({ kinds: [], groups: [] });
    expect(o.setEnabled).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), true);
  });
});

describe("an unfolded plugin family", () => {
  it("is one surface: heading row and panel share the one wrapper that carries the open style", () => {
    const out = html({ row: only(), open: true });
    const root = out.slice(0, out.indexOf(">") + 1);
    expect(root).toMatch(/open/);
    expect(out.match(/data-family=/g)).toHaveLength(1);
    expect(out.indexOf(en.plugins.panelAuthor)).toBeGreaterThan(out.indexOf("Pulse Lab"));
    const folded = html({ row: only() });
    expect(folded.slice(0, folded.indexOf(">") + 1)).not.toMatch(/open/);
  });

  it("offers Uninstall and a link to Plugins for a visualizer-only plugin, no Disable or Restart", () => {
    const out = html({ row: only(), open: true });
    expect(out).toContain(en.plugins.uninstall);
    expect(out).not.toContain(en.plugins.disable);
    expect(out).toContain("Developer mode and safe mode are in");
    expect(out).toContain(en.plugins.section);
  });

  it("adds Reload from source and Open log in developer mode, and only then", () => {
    const withRow = only({ source_path: "C:/p" });
    const dev = html({ row: withRow, open: true, ops: ops({ devMode: true }) });
    expect(dev).toContain(en.plugins.devMode.reload);
    expect(dev).toContain(en.plugins.devMode.openLog);
    expect(html({ row: withRow, open: true })).not.toContain(en.plugins.devMode.openLog);
  });

  it("points a plugin with its own page to Plugins and offers no lifecycle verbs", () => {
    const out = html({ row: mixed(), open: true });
    expect(out).toContain("From Setlist Pro");
    expect(out).toContain(en.plugins.vis.openInPlugins);
    expect(out).not.toContain(en.plugins.uninstall);
    expect(out).not.toContain(en.plugins.panelAuthor);
  });
});

