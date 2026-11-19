// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SelectionActionBar } from "./SelectionActionBar";

// -- State Imports --
import { useOrganizeStore } from "../../state/organize/store";
import { usePlaylistsStore } from "../../state/playlists/store";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

// -- Type Imports --
import type { ReactElement } from "react";
import type { FoldAction } from "../common/ActionFold/FoldedActions";

const h = vi.hoisted(() => ({
  actions: [] as unknown[],
  setters: [] as ((v: unknown) => void)[],
  status: "loading" as string,
}));

// Every state setter is a spy, so a test can tell whether the bar tried to show an error line.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: (init: unknown) => {
    const setter = vi.fn();
    h.setters.push(setter);
    return [typeof init === "function" ? (init as () => unknown)() : init, setter];
  },
}));
// A static render reads a store at its initial state, so the status the gate follows is set here.
vi.mock("../../state/projectionStatus", () => ({
  useOrgStatus: () => h.status,
  usePlaylistsStatus: () => h.status,
}));
vi.mock("../../hooks/useMountTransition", () => ({
  useMountTransition: () => ({ mounted: true, state: "enter" }),
}));
vi.mock("../common/ActionFold/FoldedActions", () => ({
  FoldedActions: (p: { actions: unknown[] }) => {
    h.actions = p.actions;
    return null;
  },
}));
vi.mock("./AlbumPicker", () => ({ AlbumPicker: () => null }));
vi.mock("../playlists/PlaylistPicker", () => ({ PlaylistPicker: () => null }));
vi.mock("../extract/ExtractPanel", () => ({ ExtractPanel: () => null }));
vi.mock("./BulkEditPanel", () => ({ BulkEditPanel: () => null }));
vi.mock("./CleanTitlesPanel", () => ({ CleanTitlesPanel: () => null }));
vi.mock("../../state/player/store", () => ({
  usePlayerActions: () => ({ addToQueue: () => {}, playNext: () => {} }),
  usePlayerEnabled: () => false,
}));
vi.mock("../../state/player/queueToast", () => ({ announceAfterBlock: () => {} }));
vi.mock("../../lib/ipc", async (original) => {
  const real = await original<typeof import("../../lib/ipc")>();
  return { ...real, createAlbum: vi.fn() };
});

const action = (id: string) => (h.actions as FoldAction[]).find((a) => a.id === id);

/** The gated button inside an action's tooltip wrapper. */
const wrapped = (id: string) => {
  const tooltip = action(id)?.node as ReactElement<{ label?: string; children: ReactElement<{ disabled?: boolean }> }>;
  return { tip: tooltip.props.label, disabled: tooltip.props.children.props.disabled };
};

function render(): void {
  renderToStaticMarkup(<SelectionActionBar onCreated={() => {}} onMadeSingles={() => {}} />);
}

/** The strings the bar handed to any state setter: only its error line is a string. */
const strings = () => h.setters.flatMap((s) => vi.mocked(s).mock.calls.map(([v]) => v)).filter((v) => typeof v === "string");

beforeEach(() => {
  vi.clearAllMocks();
  h.actions = [];
  h.setters = [];
  h.status = "loading";
  useOrganizeStore.setState({ selection: new Set([1]), orgReady: false, orgStalled: false });
  usePlaylistsStore.setState({ ready: false, stalled: false });
});

describe("SelectionActionBar before albums and playlists have loaded", () => {
  it("disables the album and playlist actions with the tooltip", () => {
    render();
    for (const id of ["create", "single", "album", "playlist"]) {
      expect(action(id)?.disabled).toBe(true);
      expect(wrapped(id)).toEqual({ tip: "Available once albums and playlists have loaded", disabled: true });
    }
  });

  it("leaves the tag actions alone", () => {
    render();
    expect(action("tags")?.disabled).toBeUndefined();
  });

  it("enables the actions once both have loaded", () => {
    h.status = "ready";
    render();
    for (const id of ["create", "single", "album", "playlist"]) {
      expect([id, action(id)?.disabled]).toEqual([id, false]);
      expect([id, wrapped(id)]).toEqual([id, { tip: undefined, disabled: false }]);
    }
  });

  it("shows no failure line when a refused create comes back not ready", async () => {
    render();
    await action("create")?.onSelect();
    await Promise.resolve();
    expect(strings()).toEqual([]);
  });

  it("still shows the failure line when the write itself fails", async () => {
    useOrganizeStore.setState({ orgReady: true });
    vi.mocked(ipc.createAlbum).mockRejectedValue(new Error("disk"));
    render();
    await action("create")?.onSelect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(strings().length).toBe(1);
  });
});
