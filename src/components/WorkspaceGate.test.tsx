// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { WorkspaceGate } from "./WorkspaceGate";

const h = vi.hoisted(() => ({
  booted: false,
  stalled: false,
  retry: vi.fn(),
  tryAgain: null as null | (() => void),
  held: false,
}));

vi.mock("../hooks/useDelayedFlag", () => ({ useDelayedFlag: (on: boolean) => on && h.held }));
vi.mock("./scan/StaffSpinner", () => ({ StaffSpinner: () => <i data-spinner="" /> }));
vi.mock("../state/store", () => ({
  useBoot: () => () => {},
  useBooted: () => h.booted,
  useBootStalled: () => h.stalled,
  useRetryBoot: () => h.retry,
  useRescanAll: () => () => {},
  useRoots: () => [],
  useScanError: () => null,
  useScanMode: () => "blocking",
  useScanStatus: () => "idle",
}));
vi.mock("./common/QuietButton", () => ({
  QuietButton: (p: { onClick?: () => void; children: string }) => {
    h.tryAgain = p.onClick ?? null;
    return <button>{p.children}</button>;
  },
}));
vi.mock("./shell/AppShell", () => ({ AppShell: () => null }));
vi.mock("./scan/ScanProgress", () => ({ ScanProgress: () => null }));
vi.mock("./settings/RelinkPrompt", () => ({ RelinkPrompt: () => null }));
vi.mock("./workspace/WorkspacePicker", () => ({ WorkspacePicker: () => <i data-picker="" /> }));

beforeEach(() => {
  vi.clearAllMocks();
  h.booted = false;
  h.stalled = false;
  h.tryAgain = null;
  h.held = false;
});

describe("WorkspaceGate before the library has booted", () => {
  it("shows no spinner, line or picker while the first reads are quick", () => {
    const html = renderToStaticMarkup(<WorkspaceGate />);
    expect(html).not.toContain("data-spinner");
    expect(html).not.toContain("Loading your library");
    expect(html).not.toContain("data-picker");
  });

  it("shows the spinner and its line once the wait is noticeable", () => {
    h.held = true;
    const html = renderToStaticMarkup(<WorkspaceGate />);
    expect(html).toContain("data-spinner");
    expect(html).toContain("Loading your library");
    expect(html).not.toContain("Try again");
  });

  it("shows the stalled state with Try again once the reads are overdue", () => {
    h.stalled = true;
    const html = renderToStaticMarkup(<WorkspaceGate />);
    expect(html).toContain("Your library has not loaded yet");
    expect(html).toContain("Nothing in your library has changed");
    expect(html).toContain("Try again");
    expect(html).not.toContain("data-picker");
  });

  it("wakes the boot reads from Try again", () => {
    h.stalled = true;
    renderToStaticMarkup(<WorkspaceGate />);
    h.tryAgain?.();
    expect(h.retry).toHaveBeenCalledTimes(1);
  });

  it("opens onto the picker once booted with no folders", () => {
    h.booted = true;
    h.stalled = true;
    const html = renderToStaticMarkup(<WorkspaceGate />);
    expect(html).toContain("data-picker");
    expect(html).not.toContain("has not loaded yet");
  });
});
