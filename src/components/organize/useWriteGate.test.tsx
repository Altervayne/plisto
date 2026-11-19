// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { useWriteGate } from "./useWriteGate";
import type { WriteGate, WriteScope } from "./useWriteGate";

const h = vi.hoisted(() => ({ org: "loading" as string, playlists: "loading" as string }));

// A static render reads a store at its initial state, so the two statuses are set here.
vi.mock("../../state/projectionStatus", () => ({
  useOrgStatus: () => h.org,
  usePlaylistsStatus: () => h.playlists,
}));

function gate(scope: WriteScope): WriteGate {
  let out!: WriteGate;
  function Probe() {
    out = useWriteGate(scope);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

const TIP = "Available once albums and playlists have loaded";

beforeEach(() => {
  h.org = "loading";
  h.playlists = "loading";
});

describe("useWriteGate", () => {
  it("blocks every scope while neither projection has loaded, with the tooltip", () => {
    for (const scope of ["albums", "playlists", "both"] as const) {
      expect(gate(scope)).toEqual({ blocked: true, tip: TIP });
    }
  });

  it("treats a stalled projection like a loading one", () => {
    h.org = "stalled";
    expect(gate("albums").blocked).toBe(true);
  });

  it("follows only the projection the scope names", () => {
    h.org = "ready";
    expect(gate("albums")).toEqual({ blocked: false, tip: undefined });
    expect(gate("playlists").blocked).toBe(true);
    expect(gate("both").blocked).toBe(true);
    h.playlists = "ready";
    expect(gate("playlists").blocked).toBe(false);
    expect(gate("both")).toEqual({ blocked: false, tip: undefined });
  });
});
