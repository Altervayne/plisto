// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { GenreAddRow } from "./GenreAddRow";

const h = vi.hoisted(() => ({
  status: "loading" as string,
  createTip: "unset" as string | undefined,
  onCreate: null as null | ((name: string) => void),
  create: vi.fn(),
}));

vi.mock("../../state/projectionStatus", () => ({
  useOrgStatus: () => h.status,
  usePlaylistsStatus: () => h.status,
}));
vi.mock("../../state/organize/store", () => ({
  useGenres: () => [],
  useCreateGenre: () => h.create,
}));
vi.mock("./SettingRow", () => ({ SettingRow: (p: { children: unknown }) => <div>{p.children as never}</div> }));
vi.mock("../common/GenreAdder", () => ({
  GenreAdder: (p: { createTip?: string; onCreate: (name: string) => void }) => {
    h.createTip = p.createTip;
    h.onCreate = p.onCreate;
    return null;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.status = "loading";
  h.createTip = "unset";
  h.onCreate = null;
});

describe("GenreAddRow", () => {
  it("hands the adder the tooltip while albums have not loaded, and none once they have", () => {
    renderToStaticMarkup(<GenreAddRow />);
    expect(h.createTip).toBe("Available once albums and playlists have loaded");
    h.status = "ready";
    renderToStaticMarkup(<GenreAddRow />);
    expect(h.createTip).toBeUndefined();
  });

  it("absorbs a refused create", async () => {
    h.create.mockRejectedValue(new Error("refused"));
    renderToStaticMarkup(<GenreAddRow />);
    h.onCreate?.("noir");
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledWith("noir");
  });
});
