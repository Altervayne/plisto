// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { GoneContent, GoneReceipt } from "./GoneContent";
import { GoneRemoveConfirm } from "./GoneRemoveConfirm";

// -- Type Imports --
import type { GoneGroup } from "../../state/gone/goneGroups";
import type { LocateStep } from "../settings/locateFlow";
import type { Root, TrackRow } from "../../types";
import type { GoneActions } from "./GoneContent";
import type { GoneView } from "./goneView";

// The confirm portals to the body, which a static render cannot do; draw its parts in place.
vi.mock("../common/ConfirmDialog/ConfirmDialog", () => ({
  ConfirmDialog: (p: { open: boolean; title: string; prompt: string; confirmLabel: string; children: unknown }) =>
    p.open ? (
      <div>
        <h2>{p.title}</h2>
        <p>{p.prompt}</p>
        {p.children as never}
        <button>{p.confirmLabel}</button>
      </div>
    ) : null,
}));

let nextId = 1;
function track(path: string): TrackRow {
  return { id: nextId++, source_path: path, filename: path.split("/").pop(), missing_at: 5 } as TrackRow;
}
function group(path: string, count: number, rootId = 1): GoneGroup {
  return { id: path, path, rootId, tracks: Array.from({ length: count }, (_, i) => track(`${path}/${i}.mp3`)) };
}
function root(id: number, path: string, trackCount: number): Root {
  return { id, path, track_count: trackCount, missing_count: 0 };
}

const EMPTY: GoneView = { offline: [], moved: [], likely: [], groups: [], flat: null, total: 0, folders: 0 };
const actions: GoneActions = {
  locate: vi.fn(),
  confirm: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn(),
  folder: { start: vi.fn(), confirm: vi.fn(), retry: vi.fn(), dismiss: vi.fn(), stop: vi.fn() },
  rescan: vi.fn(),
  remove: vi.fn(),
  toggle: vi.fn(),
  moreGroups: vi.fn(),
  moreTracks: vi.fn(),
};

function render(view: GoneView, over: Partial<Parameters<typeof GoneContent>[0]> = {}) {
  return renderToStaticMarkup(
    <GoneContent
      view={view}
      scanning={false}
      removeBlocked={false}
      steps={{}}
      folderSteps={{}}
      folderBusy={false}
      roots={[root(1, "/m", 100)]}
      expanded={new Set()}
      shownGroups={5}
      shownTracks={{}}
      metaOf={() => "Artist"}
      actions={actions}
      {...over}
    />,
  );
}

const moved = (path: string, count: number) => ({ root: root(1, path, count), tracks: group(path, count).tracks });

describe("GoneContent states", () => {
  it("lists a few tracks flat, with no folders or blocks", () => {
    const flat = group("/m/a", 4).tracks;
    const html = render({ ...EMPTY, flat, total: 4 });
    expect(html).toContain("0.mp3");
    expect(html).not.toContain("Other folders");
    expect(html).not.toContain("Likely moved");
  });

  it("shows a fully gone root as a likely-moved block with Locate folder and Remove", () => {
    const html = render({ ...EMPTY, moved: [moved("D:/Music/Rock", 412)], total: 412, folders: 1 });
    expect(html).toContain("Likely moved");
    expect(html).toContain("412 tracks");
    expect(html).toContain("Looks like it moved.");
    expect(html).toContain("Locate folder");
    expect(html).toContain("Remove from library");
  });

  it("offers a vanished subfolder the folder Locate beside Remove", () => {
    const html = render({ ...EMPTY, likely: [group("/m/rock", 12)], total: 12, folders: 1 });
    expect(html).toContain("Likely moved");
    expect(html).toContain("Remove from library");
    expect(html).toContain("Locate folder");
  });

  it("shows mixed groups under a label, one open with its tracks", () => {
    const groups = [group("/m/dl", 23), group("/m/singles", 9)];
    const html = render({ ...EMPTY, groups, total: 32, folders: 2 }, { expanded: new Set(["/m/dl"]) });
    expect(html).toContain("Other folders");
    expect(html).toContain("23 tracks");
    expect(html).toContain("22.mp3");
    expect(html).not.toContain("/m/singles/0.mp3");
  });

  it("pages folders and offers the rest behind Show more folders", () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`/m/f${i}`, 3));
    const html = render({ ...EMPTY, groups, total: 24, folders: 8 });
    expect(html).toContain("/m/f4");
    expect(html).not.toContain("/m/f5");
    expect(html).toContain("Show 3 more folders");
  });

  it("pages the tracks of an open folder", () => {
    const groups = [group("/m/big", 80)];
    const html = render({ ...EMPTY, groups, total: 80, folders: 1 }, { expanded: new Set(["/m/big"]) });
    expect(html).toContain("49.mp3");
    expect(html).not.toContain("/50.mp3");
    expect(html).toContain("Show 30 more tracks");
  });

  it("shows the offline block with Rescan and Locate and the empty state under it", () => {
    const html = render({ ...EMPTY, offline: [{ root: root(2, "E:/Archive", 6240), goneCount: 0 }] });
    expect(html).toContain("Offline");
    expect(html).toContain("kept, not gone");
    expect(html).toContain("6,240 tracks");
    expect(html).toContain("Rescan");
    expect(html).toContain("Locate...");
    expect(html).toContain("No gone tracks");
  });

  it("shows only the scan state, with no counts or rows, while a scan runs", () => {
    const html = render({ ...EMPTY, groups: [group("/m/dl", 23)], total: 23, folders: 1 }, { scanning: true });
    expect(html).toContain("A scan is running");
    expect(html).not.toContain("/m/dl");
    expect(html).not.toContain("Other folders");
  });

  it("disables Locate and Remove while a scan runs", () => {
    const view = { ...EMPTY, moved: [moved("/old", 20)], total: 20, folders: 1 };
    const idle = render(view);
    expect(idle).not.toMatch(/disabled[^>]*>Locate folder/);
    const held = render(view, { scanning: true });
    expect(held).not.toContain("Locate folder");
  });

  it("disables Remove while the write gate is closed", () => {
    const html = render({ ...EMPTY, groups: [group("/m/dl", 23)], total: 23, folders: 1 }, { removeBlocked: true });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Remove from library/);
  });

  it("lists only the offline roots it is given, so an empty root never shows", () => {
    const html = render({ ...EMPTY, offline: [{ root: root(2, "E:/Archive", 10), goneCount: 0 }] });
    expect(html.match(/Likely moved|kept, not gone/g)).toHaveLength(1);
  });
});

describe("GoneContent subfolder Locate", () => {
  const one = { ...EMPTY, groups: [group("/m/dl", 23)], total: 23, folders: 1 };

  it("offers Locate subfolder on a subfolder group only", () => {
    const html = render(one);
    expect(html).toContain("Locate subfolder");
    expect(html).toContain("Remove from library");
  });

  it("leaves a partly gone root's top level with Remove only", () => {
    const html = render({ ...EMPTY, groups: [group("/m", 23)], total: 23, folders: 1 });
    expect(html).not.toContain("Locate subfolder");
    expect(html).toContain("Remove from library");
  });

  it("offers no Locate for a group under no root", () => {
    const orphan = { ...group("/x/dl", 23), rootId: null };
    const html = render({ ...EMPTY, groups: [orphan], total: 23, folders: 1 });
    expect(html).not.toContain("Locate subfolder");
  });

  it("disables Locate subfolder while a scan or a folder apply holds the lock", () => {
    expect(render(one, { folderBusy: true })).toMatch(/<button[^>]*disabled[^>]*>Locate subfolder/);
    expect(render(one)).not.toMatch(/<button[^>]*disabled[^>]*>Locate subfolder/);
  });

  it("shows a group's step line under its row in place of the button", () => {
    const html = render(one, {
      folderSteps: { "/m/dl": { kind: "checking", name: "dl", folder: "E:/dl" } },
    });
    expect(html).toContain("Checking E:/dl...");
    expect(html).not.toContain("Locate subfolder");
  });

  it("holds another group's use action while a folder apply runs", () => {
    const plan = {
      kind: "folder" as const,
      target_root_id: 1,
      total: 23,
      relinked: 23,
      merged: 0,
      stays: 0,
      albums_replaced: 0,
      partial: false,
    };
    const folderSteps = { "/m/dl": { kind: "confirm" as const, name: "dl", folder: "E:/dl", plan } };
    expect(render(one, { folderSteps, folderBusy: true })).toMatch(/<button[^>]*disabled[^>]*>Use this folder/);
    expect(render(one, { folderSteps })).not.toMatch(/<button[^>]*disabled[^>]*>Use this folder/);
  });

  it("keeps a listed group's running step and its Cancel in view while a scan hides the rows", () => {
    const html = render(one, {
      scanning: true,
      folderBusy: true,
      folderSteps: { "/m/dl": { kind: "running", name: "dl", folder: "E:/dl" } },
    });
    expect(html).toContain("Updating dl");
    expect(html).toContain("Cancel");
  });

  it("shows a running folder apply with Cancel", () => {
    const html = render(one, {
      folderBusy: true,
      folderSteps: { "/m/dl": { kind: "running", name: "dl", folder: "E:/dl" } },
    });
    expect(html).toContain("Updating dl");
    expect(html).toContain("Cancel");
  });

  it("keeps a finished folder step as a notice once its group has left the list", () => {
    const html = render(EMPTY, {
      folderSteps: { "/m/dl": { kind: "done", name: "dl", folder: "E:/dl", missing: 2, located: 21 } },
    });
    expect(html).toContain("21 tracks now point to ");
    expect(html).toContain("E:/dl");
    expect(html).toContain("The other 2 tracks stay marked gone");
  });
});

describe("GoneContent Locate steps", () => {
  const view = { ...EMPTY, moved: [moved("D:/Music/Rock", 412)], total: 412, folders: 1 };
  const withStep = (step: LocateStep) => render(view, { steps: { 1: step } });

  it("shows the checking line with Cancel", () => {
    const html = withStep({ kind: "checking", name: "Rock", folder: "E:/Archive/Rock" });
    expect(html).toContain("Checking");
    expect(html).toContain("E:/Archive/Rock");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Locate folder");
  });

  it("shows the confirm line with the use action", () => {
    const html = withStep({
      kind: "confirm",
      name: "Rock",
      folder: "E:/Archive/Rock",
      plan: { kind: "move", matched: 398, sampled: 412, partial: true } as never,
    });
    expect(html).toContain("Found 398 of 412 checked tracks");
    expect(html).toContain("Use this folder");
    expect(html).toContain("Tracks not found stay marked gone");
  });

  it("keeps the done notice after the root stops being gone", () => {
    const html = render(EMPTY, {
      steps: { 1: { kind: "done", name: "Rock", folder: "E:/Archive/Rock", missing: 14 } },
    });
    expect(html).toContain("Rock now points to");
    expect(html).toContain("The other 14 tracks stay marked gone");
  });

  it("shows a refusal with Try again only when a retry can change it", () => {
    const retry = withStep({
      kind: "refused",
      name: "Rock",
      folder: "E:/x",
      reason: { code: "unreadable" },
    });
    expect(retry).toContain("Try again");
    const none = withStep({ kind: "refused", name: "Rock", folder: "E:/x", reason: { code: "same" } });
    expect(none).not.toContain("Try again");
  });

  it("keeps the running step of a still-listed root visible through a scan", () => {
    const html = render(view, {
      scanning: true,
      steps: { 1: { kind: "running", name: "Rock", folder: "E:/Archive/Rock" } },
    });
    expect(html).toContain("Updating Rock");
    expect(html).toContain("A scan is running");
  });

  it("keeps the notice through a scan, which the relocate itself starts", () => {
    const html = render(view, {
      scanning: true,
      steps: { 9: { kind: "running", name: "Rock", folder: "E:/Archive/Rock" } },
    });
    expect(html).toContain("Updating Rock");
    expect(html).toContain("A scan is running");
  });
});

describe("GoneReceipt and GoneRemoveConfirm", () => {
  it("states what was removed and that files were not touched", () => {
    const html = renderToStaticMarkup(<GoneReceipt removed={450} />);
    expect(html).toContain("Removed 450 tracks from your library.");
    expect(html).toContain("Your files were not touched.");
  });

  it("names the count, what is lost and what the restore point brings back", () => {
    const html = renderToStaticMarkup(<GoneRemoveConfirm count={450} onConfirm={() => {}} onClose={() => {}} />);
    expect(html).toContain("Remove 450 tracks from your library?");
    expect(html).toContain("Their plays and ratings go with them");
    expect(html).not.toContain("cannot be undone");
    expect(html).toContain("A restore point is saved first");
    expect(html).toContain("Remove 450 tracks");
  });

  it("draws nothing while no count is set", () => {
    expect(renderToStaticMarkup(<GoneRemoveConfirm count={null} onConfirm={() => {}} onClose={() => {}} />)).toBe("");
  });
});
