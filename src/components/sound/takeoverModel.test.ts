// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { takeoverView } from "./takeoverModel";

// -- Fixture Imports --
import { manifest, row, status } from "../../state/plugins/fixtures";

const rows = [row({ id: "tandem", manifest: manifest({ name: "Tandem" }) })];
const board = (...list: ReturnType<typeof status>[]) => Object.fromEntries(list.map((s) => [s.id, s]));

describe("takeoverView", () => {
  it("is absent with nothing held and nobody lost the output", () => {
    expect(takeoverView(false, {}, rows)).toBeNull();
    expect(takeoverView(false, board(status({ id: "tandem", takeover: false })), rows)).toBeNull();
  });

  it("names the holder from the plugins store", () => {
    const view = takeoverView(true, board(status({ id: "tandem", takeover: true })), rows);
    expect(view).toEqual({ kind: "held", id: "tandem", name: "Tandem", text: null });
  });

  it("carries the holder's own report as the second line, trimmed, only when present", () => {
    const reported = (text: string | null) =>
      board(status({ id: "tandem", takeover: true, reported: { state: "on", text } }));
    expect(takeoverView(true, reported("  Mirroring to 3 devices "), rows)).toMatchObject({
      text: "Mirroring to 3 devices",
    });
    expect(takeoverView(true, reported("   "), rows)).toMatchObject({ text: null });
    expect(takeoverView(true, reported(null), rows)).toMatchObject({ text: null });
  });

  it("falls back to the id when the row has no manifest", () => {
    const view = takeoverView(true, board(status({ id: "ghost", takeover: true })), rows);
    expect(view).toMatchObject({ kind: "held", name: "ghost" });
  });

  it("shows a nameless line when the output is held but no status says by whom", () => {
    expect(takeoverView(true, {}, rows)).toEqual({ kind: "held", id: null, name: null, text: null });
  });

  it("shows the not-responding line for a plugin that lost the output", () => {
    const lost = status({ id: "tandem", host: "not_responding", takeover_revoked: "not_responding" });
    expect(takeoverView(false, board(lost), rows)).toEqual({ kind: "notResponding", name: "Tandem" });
  });

  it("needs both the host state and the revocation for the not-responding line", () => {
    const hung = status({ id: "tandem", host: "not_responding", takeover_revoked: null });
    const recovered = status({ id: "tandem", host: "running", takeover_revoked: "not_responding" });
    expect(takeoverView(false, board(hung), rows)).toBeNull();
    expect(takeoverView(false, board(recovered), rows)).toBeNull();
  });
});
