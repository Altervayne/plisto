// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The static renderer has no portal target, which the tooltip bubble would need.
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

// -- Unit Imports --
import { RestorePointRow } from "./RestorePointRow";

// -- i18n Imports --
import { en } from "../../../i18n/en";

// -- Type Imports --
import type { RestorePointRow as Row, RestorePointStatus } from "../../../types";

const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const AT = new Date(2026, 10, 19, 11, 5).getTime();

const ready = (over: Partial<Extract<RestorePointStatus, { kind: "ready" }>> = {}): RestorePointStatus => ({
  kind: "ready",
  app_version: "2.7.2",
  detail: null,
  albums: 1312,
  singles: 214,
  playlists: 31,
  filed_tracks: 9000,
  edited_tracks: 48,
  genre_tracks: 3120,
  ...over,
});

const point = (reason: Row["reason"], status: RestorePointStatus): Row => ({
  file: "point.sqlite",
  reason,
  created_at: AT,
  bytes: 1,
  status,
});

// The renderer writes an apostrophe as an entity.
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

const render = (row: Row, canRestore = true) =>
  renderToStaticMarkup(<RestorePointRow row={row} canRestore={canRestore} onRestore={() => {}} now={NOW} />);

describe("RestorePointRow kinds", () => {
  it("names a version point for the version", () => {
    expect(render(point("version", ready({ detail: "2.7.1" })))).toContain("Before updating to 2.7.2");
  });

  it("names a daily point", () => {
    expect(render(point("daily", ready()))).toContain(">Daily<");
  });

  it("names a point taken before a restore", () => {
    expect(render(point("restore", ready({ detail: "old.sqlite" })))).toContain(">Before a restore<");
  });

  it.each([
    ["tags_apply", en.tagAlbums.entry],
    ["remove_root", en.settings.remove],
    ["purge", en.tracks.removeGone],
    ["relocate", en.settings.locate],
    ["merge_duplicates", en.restorePoints.actionMerge],
    ["delete_albums", en.restorePoints.actionDeleteAlbums],
  ])("names the %s action with its existing label", (key, label) => {
    const html = render(point("action", ready({ detail: key })));
    expect(html).toContain(`Before action: ${label}`);
  });

  it("falls back to a plain name for an action it does not know", () => {
    const html = render(point("action", ready({ detail: "new_thing" })));
    expect(html).toContain(">Before a change<");
    expect(html).not.toContain("new_thing");
  });
});

describe("RestorePointRow line", () => {
  it("reads absolute date first, then version and counts only", () => {
    const html = render(point("daily", ready()));
    expect(html).toContain("19 Nov 2026, 11:05");
    expect(html).toContain("Plisto 2.7.2");
    expect(html).toContain("1,312 albums");
    expect(html).toContain("214 singles");
    expect(html).toContain("31 playlists");
    expect(html.indexOf("19 Nov 2026")).toBeLessThan(html.indexOf("Plisto 2.7.2"));
  });

  it("does not show the relative date on the row itself", () => {
    expect(render(point("daily", ready()))).not.toContain("min ago");
  });

  it("offers Restore, and holds it while a restore or a scan runs", () => {
    const open = render(point("daily", ready()));
    expect(open).toContain(en.restorePoints.restore);
    expect(open).not.toContain("disabled");
    expect(render(point("daily", ready()), false)).toContain("disabled");
  });
});

describe("RestorePointRow flagged rows", () => {
  it("flags an unreadable point, with no counts and no Restore", () => {
    const html = render(point("daily", { kind: "unreadable", error: "bad" }));
    expect(html).toContain(escaped(en.restorePoints.unreadable));
    expect(html).toContain(escaped(en.restorePoints.unreadableLine));
    expect(html).not.toContain(en.restorePoints.restore);
    expect(html).not.toContain("albums");
  });

  it("flags a newer-format point, with no Restore", () => {
    const html = render(point("daily", { kind: "newer", format: 9 }));
    expect(html).toContain(en.restorePoints.newer);
    expect(html).toContain(en.restorePoints.newerLine);
    expect(html).not.toContain(en.restorePoints.restore);
  });
});
