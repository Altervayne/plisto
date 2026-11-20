// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The static renderer has no portal target, so the sheets render in place.
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.stubGlobal("document", { body: {} });

// -- Unit Imports --
import { RestoreSheet } from "./RestoreSheet";
import { RestoreResultSheet } from "./RestoreResultSheet";
import { RestoreFailureSheet } from "./RestoreFailureSheet";
import { failureText } from "./failureText";

// -- i18n Imports --
import { en } from "../../../i18n/en";
import { fr } from "../../../i18n/fr";
import { createT } from "../../../i18n";

// -- Type Imports --
import type { RestoreFailureKey } from "../../../state/restorePoints/store";
import type { RestorePointRow, RestoreSummary, UnmatchedGroup } from "../../../types";

const escaped = (text: string) => text.replace(/'/g, "&#x27;");

const row = (over: Partial<Extract<RestorePointRow["status"], { kind: "ready" }>> = {}): RestorePointRow => ({
  file: "p.sqlite",
  reason: "daily",
  created_at: new Date(2026, 10, 19, 8, 40).getTime(),
  bytes: 1,
  status: {
    kind: "ready",
    app_version: "2.7.2",
    detail: null,
    albums: 1300,
    singles: 214,
    playlists: 31,
    filed_tracks: 9000,
    edited_tracks: 48,
    genre_tracks: 3120,
    ...over,
  },
});

const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({
  albums: 1300,
  singles: 214,
  playlists: 31,
  filed_tracks: 9000,
  unmatched_tracks: 0,
  albums_not_recreated: 0,
  collapsed: 0,
  dropped_entries: 0,
  cleared_tracks: 0,
  unmatched: [],
  ...over,
});

const album = (title: string, paths: string[]): UnmatchedGroup => ({ kind: "album", id: 1, title, paths });
const playlist = (title: string, paths: string[]): UnmatchedGroup => ({ kind: "playlist", id: 2, title, paths });

const sheet = (s: RestoreSummary, r = row()) =>
  renderToStaticMarkup(<RestoreSheet row={r} summary={s} onConfirm={() => {}} onClose={() => {}} />);

describe("RestoreSheet", () => {
  it("opens with the exact date of the point and the counts that come back", () => {
    const html = sheet(summary());
    expect(html).toContain("Restore the point of 19 Nov 2026, 08:40?");
    expect(html).toContain(">1,300<");
    expect(html).toContain(">214<");
    expect(html).toContain(">31<");
  });

  it("says every track was found, and lists nothing lost, when none is missing", () => {
    const html = sheet(summary());
    expect(html).toContain(en.restorePoints.allFound);
    expect(html).not.toContain("not found in your library");
    expect(html).not.toContain("not recreated");
    expect(html).not.toContain("are cleared");
  });

  it("says what edits and genres come back", () => {
    expect(sheet(summary())).toContain("Edits on 48 tracks and genres on 3,120 tracks come back.");
    expect(sheet(summary(), row({ genre_tracks: 0 }))).toContain("Edits on 48 tracks come back.");
    expect(sheet(summary(), row({ edited_tracks: 0 }))).toContain("Genres on 3,120 tracks come back.");
    expect(sheet(summary(), row({ edited_tracks: 0, genre_tracks: 0 }))).not.toContain("come back");
  });

  it("lists only what is lost, and the grouped unmatched list, when tracks are missing", () => {
    const html = sheet(
      summary({
        unmatched_tracks: 1284,
        albums_not_recreated: 3,
        cleared_tracks: 9,
        unmatched: [album("Mezzanine", ["a", "b", "c"]), playlist("Drive", ["d"])],
      }),
    );
    expect(html).toContain("1,284 tracks not found in your library");
    expect(html).toContain("3 albums not recreated");
    expect(html).toContain("Edits on 9 tracks added since are cleared");
    expect(html).not.toContain(en.restorePoints.allFound);
    expect(html).toContain("Mezzanine");
    expect(html).toContain("3 tracks");
    expect(html).toContain(">Playlists<");
    expect(html).toContain("Drive");
  });

  it("leaves the unmatched list out when nothing is missing", () => {
    expect(sheet(summary())).not.toContain("_unmatched_");
  });

  it("shows no paths in the preview list", () => {
    const html = sheet(summary({ unmatched_tracks: 1, unmatched: [album("Mezzanine", ["D:\\Music\\01.flac"])] }));
    expect(html).not.toContain("D:\\Music");
  });

  it("states that a point of now is saved first", () => {
    expect(sheet(summary())).toContain(en.restorePoints.safe);
  });

  it("warns, without blocking, when every track is unmatched", () => {
    const html = sheet(
      summary({
        albums: 0,
        singles: 0,
        filed_tracks: 0,
        unmatched_tracks: 18402,
        albums_not_recreated: 1514,
        unmatched: [album("Mezzanine", ["a"])],
      }),
    );
    expect(html).toContain(escaped(en.restorePoints.allTitle));
    expect(html).toContain("Restoring would leave no albums and 31 playlists with nothing in them.");
    expect(html).toContain("All 1,514 albums and singles are not recreated");
    expect(html).not.toContain("Edits on 48");
    expect(html).not.toContain("Mezzanine");
    expect(html).not.toContain("disabled");
  });

  it("words the all-unmatched warning without playlists when the point has none", () => {
    const html = sheet(summary({ playlists: 0, filed_tracks: 0, unmatched_tracks: 5 }));
    expect(html).toContain(en.restorePoints.allLineNone);
  });

  it("confirms plainly, not in the danger tint, with Cancel first", () => {
    const html = sheet(summary());
    expect(html).not.toContain("destructive");
    expect(html.indexOf(">Cancel<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Cancel<")).toBeLessThan(html.indexOf(">Restore<"));
    expect(html).toContain("wide");
  });
});

const result = (s: RestoreSummary, canUndo = true) =>
  renderToStaticMarkup(
    <RestoreResultSheet when="19 Nov 2026, 08:40" summary={s} canUndo={canUndo} onUndo={() => {}} onDone={() => {}} />,
  );

describe("RestoreResultSheet", () => {
  it("summarises what is back, with Undo restore beside Done and no Cancel", () => {
    const html = result(summary());
    expect(html).toContain("Restored the point of 19 Nov 2026, 08:40");
    expect(html).toContain("1,300 albums, 214 singles and 31 playlists are back.");
    expect(html).toContain(">Undo restore<");
    expect(html).toContain(">Done<");
    expect(html).not.toContain(">Cancel<");
    expect(html.indexOf(">Undo restore<")).toBeLessThan(html.indexOf(">Done<"));
    expect(html).toContain(en.restorePoints.undoLine);
  });

  it("says a scan is running, keeping Undo, when Undo was refused", () => {
    const html = renderToStaticMarkup(
      <RestoreResultSheet when="x" summary={summary()} canUndo undoBusy onUndo={() => {}} onDone={() => {}} />,
    );
    expect(html).toContain(en.restorePoints.undoBusy);
    expect(html).not.toContain(en.restorePoints.undoLine);
    expect(html).toContain(">Undo restore<");
  });

  it("offers no undo when no point of the old library was saved", () => {
    const html = result(summary(), false);
    expect(html).not.toContain("Undo restore");
    expect(html).toContain(">Done<");
  });

  it("offers Copy list with the missing count, and the paths, when tracks were not found", () => {
    const html = result(
      summary({
        unmatched_tracks: 1284,
        albums_not_recreated: 3,
        unmatched: [album("Mezzanine", ["D:\\Music\\Massive Attack\\01 Angel.flac"])],
      }),
    );
    expect(html).toContain("Copy list (1,284)");
    expect(html).toContain("D:\\Music\\Massive Attack\\01 Angel.flac");
    expect(html).toContain("1,284 tracks not found in your library");
  });

  it("offers no Copy list when nothing was missing", () => {
    expect(result(summary())).not.toContain("Copy list");
  });
});

describe("RestoreFailureSheet", () => {
  const failure = (key: RestoreFailureKey, detail: string | null = null) =>
    renderToStaticMarkup(<RestoreFailureSheet failure={{ key, detail }} onClose={() => {}} />);

  it("says nothing changed, gives the reason and a single Close", () => {
    const html = failure("before_point", "disk full");
    expect(html).toContain(escaped(en.restorePoints.failTitle));
    expect(html).toContain(escaped(en.restorePoints.failPrompt));
    expect(html).toContain(escaped(en.restorePoints.failBeforePoint));
    expect(html).toContain(">Close<");
    expect(html).not.toContain(">Cancel<");
  });
});

describe("failureText", () => {
  const keys: RestoreFailureKey[] = ["newer", "unreadable", "integrity", "before_point", "busy", "failed"];

  it("gives every failure key its own reason in both languages", () => {
    for (const dict of [en, fr]) {
      const t = createT(dict === en ? "en" : "fr");
      const reasons = keys.map((key) => failureText(t, { key, detail: "9" }));
      expect(new Set(reasons).size).toBe(keys.length);
      expect(reasons.every((r) => r.trim() !== "")).toBe(true);
    }
  });

  it("names the format of a newer point", () => {
    expect(failureText(createT("en"), { key: "newer", detail: "9" })).toContain("format 9");
  });

  it("uses the scan-running wording for a busy refusal", () => {
    expect(failureText(createT("en"), { key: "busy", detail: null })).toBe(en.settings.locateBusy);
  });
});
