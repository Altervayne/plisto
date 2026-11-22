// -- Framework Imports --
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

// -- Test Imports --
import { vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PluginFamily } from "./PluginFamily";
import { catalogFamilies } from "./useCatalogRows";
import { QuietButton } from "../../common/QuietButton";
import { Switch } from "../../common/Switch/Switch";

// -- State Imports --
import { buildCatalog, serializeCatalog } from "../../../state/player/visualizerCatalog";
import { usePluginsStore } from "../../../state/plugins/store";
import { manifest, row, status, visualizerDecl, visualizerRow } from "../../../state/plugins/fixtures";
import { openPluginFamily, useClearPluginFamilyFocus } from "../../../state/shell/store";

// -- Type Imports --
import type { FamilyOps } from "./useFamilyOps";
import type { PluginBootState, PluginRow } from "../../../types";

/*
 * Shared setup for the plugin family tests: rows, the family a row produces, and a way to read both the
 * markup and the element tree of one render. The test files mock zustand so hooks read live state.
 */

export const ID = "com.test.pulse";
export const RUNNING: PluginBootState = { runtime: "running", unclean: false, safe_flag: false };
export const SAFE: PluginBootState = { runtime: "safe", unclean: false, safe_flag: true };
export const catalog = buildCatalog(serializeCatalog({ kinds: [], groups: [] }), false);

export const decls = [
  visualizerDecl({ id: "rings", name: "Rings" }),
  visualizerDecl({ id: "drift", name: "Drift" }),
];
export const only = (over: Partial<PluginRow> = {}) => visualizerRow(ID, "Pulse Lab", decls, over);
export const mixed = (over: Partial<PluginRow> = {}) =>
  row({ id: ID, manifest: manifest({ name: "Setlist Pro", visualizers: decls }), ...over });

export const ops = (over: Partial<FamilyOps> = {}): FamilyOps => ({
  busy: false,
  devMode: false,
  currentVersion: "2.8.0",
  setEnabled: vi.fn(),
  review: vi.fn(),
  uninstall: vi.fn(),
  reload: vi.fn(),
  restartNormally: vi.fn(),
  ...over,
});

/** The shell store is private, and a static render runs no effects, so a probe clears the focus. */
export function clearFocus(): void {
  function Probe() {
    useClearPluginFamilyFocus()();
    return null;
  }
  renderToStaticMarkup(<Probe />);
}

export interface Setup {
  row: PluginRow;
  boot?: PluginBootState;
  crash?: boolean;
  open?: boolean;
  ops?: FamilyOps;
}

/** The family of one row, with the stores it reads seeded. */
export function familyOf(setup: Setup, groups: string[] = []) {
  usePluginsStore.setState({ rows: [setup.row] });
  clearFocus();
  if (setup.open) openPluginFamily(setup.row.id);
  const statuses = setup.crash ? { [setup.row.id]: status({ id: setup.row.id, host: "crash_loop" }) } : {};
  const flagged = buildCatalog(serializeCatalog({ kinds: [], groups }), false);
  const family = catalogFamilies(flagged, {
    rows: [setup.row],
    boot: setup.boot ?? RUNNING,
    statuses,
  }).find((f) => f.plugin)!;
  return { family, ops: setup.ops ?? ops(), onChange: vi.fn() };
}

export const html = (setup: Setup) => {
  const { family, ops: o, onChange } = familyOf(setup);
  return renderToStaticMarkup(<PluginFamily family={family} catalog={catalog} onChange={onChange} ops={o} />);
};

export function elements(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement<Record<string, unknown>>(node)) {
    out.push(node);
    elements(node.props.children as ReactNode, out);
  }
  return out;
}

/** The element tree a component function returns, with hooks run inside a render. */
export function treeOf(render: () => ReactNode) {
  let out: ReactElement<Record<string, unknown>>[] = [];
  function Probe() {
    out = elements(render());
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

export const familyTree = (setup: Setup, groups: string[] = []) => {
  const { family, ops: o, onChange } = familyOf(setup, groups);
  const live = buildCatalog(serializeCatalog({ kinds: [], groups }), false);
  const tree = treeOf(() => PluginFamily({ family, catalog: live, onChange, ops: o }));
  return { tree, ops: o, onChange };
};
export const switches = (tree: ReturnType<typeof treeOf>) => tree.filter((e) => e.type === Switch);
export const buttons = (tree: ReturnType<typeof treeOf>) => tree.filter((e) => e.type === QuietButton);
