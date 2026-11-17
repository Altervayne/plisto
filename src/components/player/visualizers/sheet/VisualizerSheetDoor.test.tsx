// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { VisualizerSheet } from "./VisualizerSheet";

// -- State Imports --
import { useVisualizerSheet } from "../../../../state/player/visualizerSheet";
import { buildCatalog } from "../../../../state/player/visualizerCatalog";
import { resolveVisualizer, type ResolveInput } from "../../../../state/player/visualizerResolve";

const h = vi.hoisted(() => ({
  resolved: null as unknown,
  openSettings: vi.fn(),
  footer: null as null | { onManage?: () => void },
}));

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
vi.mock("../../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => false }));
vi.mock("../../../../state/shell/store", () => ({ useOpenSettings: () => h.openSettings }));
vi.mock("../useVisualizerResolution", () => ({ useVisualizerResolution: () => h.resolved }));
vi.mock("../useVisualizerPick", () => ({ useVisualizerPick: () => vi.fn() }));
vi.mock("../useWarmVisualizers", () => ({ useWarmSheetKinds: () => undefined }));
// The footer is replaced by a probe that keeps the props the sheet hands it.
vi.mock("./SheetFooter", () => ({
  SheetFooter: (props: { onManage?: () => void }) => {
    h.footer = props;
    return null;
  },
}));

function renderSheet(place: "player" | "ambient"): void {
  const input: ResolveInput = {
    global: "ridge",
    trackDefault: null,
    albumDefault: null,
    override: null,
    albumKey: "album:7",
    catalog: buildCatalog(undefined, false),
  };
  h.resolved = { place: { kind: "album", trackId: 3, albumId: 7 }, input, resolution: resolveVisualizer(input) };
  useVisualizerSheet.setState({ isOpen: true });
  renderToStaticMarkup(<VisualizerSheet place={place} trackId={3} />);
}

beforeEach(() => {
  h.footer = null;
  h.openSettings.mockClear();
  useVisualizerSheet.setState({ isOpen: false });
});

describe("VisualizerSheet manage link handler", () => {
  it("closes the sheet and opens Settings on the catalog in the Player", () => {
    renderSheet("player");
    expect(h.footer?.onManage).toBeTypeOf("function");
    h.footer?.onManage?.();
    expect(useVisualizerSheet.getState().isOpen).toBe(false);
    expect(h.openSettings).toHaveBeenCalledWith({ target: "visualizerCatalog" });
  });

  it("is not handed to the footer in the ambient view", () => {
    renderSheet("ambient");
    expect(h.footer).not.toBeNull();
    expect(h.footer?.onManage).toBeUndefined();
  });
});
