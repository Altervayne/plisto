// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// -- Unit Imports --
import { labelDoor, showReviewHint } from "./goneDoors";
import { CoverBadge } from "../common/CoverBadge/CoverBadge";
import { LibraryStatus } from "../shell/LibraryStatus";
import { FolderRow } from "../settings/FolderRow";

const h = vi.hoisted(() => ({
  goneTotal: null as number | null,
  openGone: vi.fn(),
  openSettings: vi.fn(),
  labelClick: null as null | (() => void),
  orgReady: true,
  offline: [] as number[],
  doorActions: [] as { text: string; onAction: () => void }[],
}));

vi.mock("../common/Tooltip/Tooltip", () => ({
  Tooltip: ({ label, children }: { label?: unknown; children: ReactElement<{ className?: string; onClick?: () => void }> }) => {
    // The first tooltip child in LibraryStatus is the label button.
    if (!h.labelClick && children.props.onClick) h.labelClick = children.props.onClick;
    return (
      <div>
        <span data-tip>{label as never}</span>
        {children}
      </div>
    );
  },
}));
vi.mock("../../state/store", () => ({
  useGoneCount: () => 0,
  useOfflineRoots: () => h.offline,
  useQuietCheckFailed: () => false,
  useRescanQuiet: () => vi.fn(),
  useRoots: () => [],
  useScanAdded: () => 0,
  useScanCheckedAt: () => null,
  useScanMode: () => "quiet",
  useScanProgress: () => null,
  useScanStatus: () => "idle",
  useBlockingScan: () => false,
  useRemoveRoot: () => vi.fn(),
}));
vi.mock("../../state/shell/store", () => ({
  useOpenGone: () => h.openGone,
  useOpenSettings: () => h.openSettings,
}));
vi.mock("../../state/gone/goneEntry", () => ({
  useGoneLibrary: () => (h.goneTotal == null ? null : { total: h.goneTotal }),
}));
vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => (h.orgReady ? "ready" : "loading") }));
vi.mock("../../state/scanIssues", () => ({ useScanIssuesStore: { getState: () => ({}) } }));
vi.mock("../../lib/ipc", () => ({ rootRemovalImpact: vi.fn() }));
vi.mock("../settings/useLocateFlow", () => ({
  useLocateFlow: () => ({ step: { kind: "idle" }, start: vi.fn(), confirm: vi.fn(), recheck: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("../settings/useMergeHint", () => ({ useMergeHint: () => null }));
vi.mock("../gone/GoneDoorLine", () => ({
  GoneDoorLine: (p: { text: string; action: string; onAction: () => void }) => {
    h.doorActions.push(p);
    return <span>{`${p.text} ${p.action}`}</span>;
  },
}));

beforeEach(() => {
  h.goneTotal = null;
  h.labelClick = null;
  h.orgReady = true;
  h.offline = [];
  h.doorActions = [];
  h.openGone.mockClear();
  h.openSettings.mockClear();
});

const label = { kind: "single", path: "D:/Music" } as never;

describe("title-bar label routing", () => {
  it("maps gone tracks to the sheet and everything else to Settings", () => {
    expect(labelDoor(1284)).toBe("gone");
    expect(labelDoor(0)).toBe("settings");
    expect(labelDoor(null)).toBe("settings");
    expect(showReviewHint(3)).toBe(true);
    expect(showReviewHint(0)).toBe(false);
  });

  it("opens the sheet over the whole library while tracks are gone", () => {
    h.goneTotal = 12;
    renderToStaticMarkup(<LibraryStatus label={label} />);
    h.labelClick?.();
    expect(h.openGone).toHaveBeenCalledWith({ kind: "all" });
    expect(h.openSettings).not.toHaveBeenCalled();
  });

  it("opens Settings > Folders when only a root is offline", () => {
    h.goneTotal = 0;
    h.offline = [2];
    renderToStaticMarkup(<LibraryStatus label={label} />);
    h.labelClick?.();
    expect(h.openSettings).toHaveBeenCalledWith({ target: "folders" });
    expect(h.openGone).not.toHaveBeenCalled();
  });

  it("opens Settings > Folders when clean, and while the organization has not loaded", () => {
    for (const total of [0, null]) {
      h.goneTotal = total;
      h.labelClick = null;
      renderToStaticMarkup(<LibraryStatus label={label} />);
      (h.labelClick as (() => void) | null)?.();
    }
    expect(h.openSettings).toHaveBeenCalledTimes(2);
    expect(h.openGone).not.toHaveBeenCalled();
  });

  it("adds the review line to the tooltip only with gone tracks", () => {
    h.goneTotal = 5;
    expect(renderToStaticMarkup(<LibraryStatus label={label} />)).toContain("Click to review");
    h.goneTotal = 0;
    expect(renderToStaticMarkup(<LibraryStatus label={label} />)).not.toContain("Click to review");
    h.goneTotal = null;
    expect(renderToStaticMarkup(<LibraryStatus label={label} />)).not.toContain("Click to review");
  });
});

describe("album badge", () => {
  it("runs its action and keeps the click from reaching the album tile", () => {
    const action = vi.fn();
    const badge = CoverBadge({ tone: "warn", label: "2 tracks missing", onClick: action }) as ReactElement<{
      onClick: (e: unknown) => void;
    }>;
    const stopPropagation = vi.fn();
    badge.props.onClick({ stopPropagation });
    expect(action).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("is plain text without an action", () => {
    const html = renderToStaticMarkup(<CoverBadge tone="warn" label="2 tracks missing" />);
    expect(html).not.toContain("role=\"button\"");
  });
});

describe("Settings > Folders line", () => {
  const root = (over = {}) => ({ id: 7, path: "D:/Music", track_count: 100, missing_count: 40, ...over }) as never;

  it("opens the sheet on that root's scope", () => {
    renderToStaticMarkup(<FolderRow root={root()} />);
    expect(h.doorActions).toHaveLength(1);
    expect(h.doorActions[0].text).toBe("40 gone");
    h.doorActions[0].onAction();
    expect(h.openGone).toHaveBeenCalledWith({ kind: "root", rootId: 7 });
  });

  it("draws no line for a clean root, an offline root, or before the organization loads", () => {
    renderToStaticMarkup(<FolderRow root={root({ missing_count: 0 })} />);
    h.offline = [7];
    renderToStaticMarkup(<FolderRow root={root()} />);
    h.offline = [];
    h.orgReady = false;
    renderToStaticMarkup(<FolderRow root={root()} />);
    expect(h.doorActions).toHaveLength(0);
  });
});
