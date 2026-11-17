// -- Framework Imports --
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { DefaultsAside } from "./DefaultsAside";

// -- State Imports --
import { useVisualizerDefaults } from "../../../../state/player/visualizerDefaults";
import { buildCatalog, serializeCatalog } from "../../../../state/player/visualizerCatalog";
import {
  resolveVisualizer,
  type ResolveInput,
  type TrackPlace,
} from "../../../../state/player/visualizerResolve";
import type { VisualizerResolution } from "../useVisualizerResolution";

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

type Node = ReactElement<Record<string, unknown>>;

const place: TrackPlace = { kind: "album", trackId: 3, albumId: 7 };
const setAlbumDefault = vi.fn(() => Promise.resolve(true));
const setTrackDefault = vi.fn(() => Promise.resolve(true));

function elements(node: ReactNode, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement<Record<string, unknown>>(node)) {
    out.push(node);
    elements(node.props.children as ReactNode, out);
  }
  return out;
}

function resolvedOf(patch: Partial<ResolveInput>): VisualizerResolution {
  const input: ResolveInput = {
    global: "ridge",
    trackDefault: null,
    albumDefault: null,
    override: null,
    albumKey: "album:7",
    catalog: buildCatalog(undefined, false),
    ...patch,
  };
  return { place, input, resolution: resolveVisualizer(input) };
}

const off = (...kinds: string[]) => buildCatalog(serializeCatalog({ kinds, groups: [] }), false);

/** The element tree the aside returns, with its hooks run inside a render. */
function treeOf(resolved: VisualizerResolution): Node[] {
  let out: Node[] = [];
  function Probe() {
    out = elements(DefaultsAside({ resolved, fallback: null }));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

const textOf = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" ? node : "";
const buttons = (tree: Node[]) => tree.filter((e) => e.type === "button");
const labelOf = (button: Node) => textOf(button.props.children as ReactNode);
const clearButton = (tree: Node[]) => {
  const all = buttons(tree);
  return all[all.length - 1];
};
const lines = (tree: Node[]) => tree.filter((e) => e.type === "div" && typeof e.props.children === "string");

/** A press on the clear pill; its handler only reads the event to find the checked tile. */
function pressClear(tree: Node[]) {
  const clear = clearButton(tree);
  const press = clear.props.onClick as (event: unknown) => void;
  press({ currentTarget: { closest: () => null } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useVisualizerDefaults.setState({ status: "ready", setAlbumDefault, setTrackDefault });
});

describe("DefaultsAside skipped line", () => {
  it("names a turned-off track default", () => {
    const tree = treeOf(resolvedOf({ trackDefault: "train", catalog: off("train") }));
    expect(lines(tree).map((l) => l.props.children)).toEqual(["Track default: Train, turned off"]);
  });

  it("names a turned-off album default", () => {
    const tree = treeOf(resolvedOf({ albumDefault: "train", catalog: off("train") }));
    expect(lines(tree).map((l) => l.props.children)).toEqual(["Album default: Train, turned off"]);
  });

  it("replaces the following line when a turned-off track default sits over a live album default", () => {
    const tree = treeOf(resolvedOf({ trackDefault: "train", albumDefault: "nebula", catalog: off("train") }));
    expect(lines(tree).map((l) => l.props.children)).toEqual(["Track default: Train, turned off"]);
  });

  it("keeps the following line when the default is on", () => {
    const tree = treeOf(resolvedOf({ albumDefault: "nebula" }));
    expect(lines(tree).map((l) => l.props.children)).toEqual(["Following this album's default"]);
  });

  it("keeps the override line while a skipped default is set aside", () => {
    const override = { kind: "bloom", albumKey: "album:7" } as const;
    const tree = treeOf(resolvedOf({ trackDefault: "train", albumDefault: "nebula", override, catalog: off("train") }));
    expect(lines(tree).map((l) => l.props.children)).toEqual(["Set aside until the album changes"]);
    expect(labelOf(clearButton(tree))).toBe("Clear track default");
  });
});

describe("DefaultsAside clear pill", () => {
  it("reads Clear default with nothing skipped", () => {
    const tree = treeOf(resolvedOf({ albumDefault: "nebula" }));
    expect(labelOf(clearButton(tree))).toBe("Clear default");
  });

  it("names the track tier and clears it", () => {
    const tree = treeOf(resolvedOf({ trackDefault: "train", albumDefault: "nebula", catalog: off("train") }));
    expect(labelOf(clearButton(tree))).toBe("Clear track default");
    pressClear(tree);
    expect(setTrackDefault).toHaveBeenCalledWith(3, null);
    expect(setAlbumDefault).not.toHaveBeenCalled();
  });

  it("names the album tier and clears it", () => {
    const tree = treeOf(resolvedOf({ albumDefault: "train", catalog: off("train") }));
    expect(labelOf(clearButton(tree))).toBe("Clear album default");
    pressClear(tree);
    expect(setAlbumDefault).toHaveBeenCalledWith(7, null);
    expect(setTrackDefault).not.toHaveBeenCalled();
  });

  it("clears the skipped track tier from under an override", () => {
    const override = { kind: "bloom", albumKey: "album:7" } as const;
    const tree = treeOf(resolvedOf({ trackDefault: "train", albumDefault: "nebula", override, catalog: off("train") }));
    pressClear(tree);
    expect(setTrackDefault).toHaveBeenCalledWith(3, null);
  });
});
