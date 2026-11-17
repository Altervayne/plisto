// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { handlePaste } from "./pasteFlow";
import type { OpenHold, PasteDeps } from "./pasteFlow";

// -- Type Imports --
import type { ActionVerdict, PasteAnswer } from "./types";

const layout = { region: { w: 10, h: 10 }, reference: { x: 0, y: 0, w: 1, h: 1 }, subject: { x: 0, y: 0, w: 1, h: 1 } };
const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

function harness(read: PasteDeps["read"] = async () => image) {
  const lines: string[] = [];
  const verdicts: [string, ActionVerdict][] = [];
  const deps: PasteDeps = {
    read,
    appendLine: (id, line) => void lines.push(`${id}: ${line}`),
    applyVerdict: (id, v) => void verdicts.push([id, v]),
  };
  return { lines, verdicts, deps };
}

const hold = (onPaste: () => Promise<string | PasteAnswer>): OpenHold => ({
  id: "P1",
  request: { label: "case", onPaste },
  layout,
  dpr: 1,
});

describe("handlePaste", () => {
  it("judges an image paste for the open hold and delivers its line and verdict", async () => {
    const { lines, verdicts, deps } = harness();
    const handling = handlePaste(
      hold(async () => ({ line: "beyond 2/255", verdict: { state: "invalid" } })),
      null,
      ["image/png"],
      () => new Blob(),
      deps,
    );
    expect(handling.handled).toBe(true);
    await handling.done;
    expect(lines).toEqual(["P1: beyond 2/255"]);
    expect(verdicts).toEqual([["P1", { state: "invalid" }]]);
  });

  it("answers with the hold that was open at paste time, even when it ends while the image decodes", async () => {
    let finishDecode: () => void = () => {};
    const { lines, deps } = harness(() => new Promise((resolve) => (finishDecode = () => resolve(image))));
    const open = hold(async () => "judged");
    const handling = handlePaste(open, null, ["image/png"], () => new Blob(), deps);
    // The hold is released here; the pasted image is still judged when it arrives.
    finishDecode();
    await handling.done;
    expect(lines).toEqual(["P1: judged"]);
  });

  it("ignores a paste with no hold open, with a line on the last card", () => {
    const { lines, deps } = harness();
    const handling = handlePaste(null, "P1", ["image/png"], () => new Blob(), deps);
    expect(handling.handled).toBe(false);
    expect(lines).toEqual(["P1: paste ignored: no case is held"]);
  });

  it("ignores a paste that is not an image, and one with nowhere to report", () => {
    const { lines, deps } = harness();
    expect(handlePaste(hold(async () => "x"), null, ["text/plain"], () => null, deps).handled).toBe(false);
    expect(lines).toEqual(["P1: paste ignored: the clipboard holds no image"]);
    const quiet = harness();
    expect(handlePaste(null, null, ["image/png"], () => null, quiet.deps).handled).toBe(false);
    expect(quiet.lines).toEqual([]);
  });

  it("reports an unreadable clipboard image and a failed decode", async () => {
    const unreadable = harness();
    await handlePaste(hold(async () => "x"), null, ["image/png"], () => null, unreadable.deps).done;
    expect(unreadable.lines[0]).toContain("paste failed: the clipboard image could not be read");
    const broken = harness(async () => Promise.reject(new Error("bad png")));
    await handlePaste(hold(async () => "x"), null, ["image/png"], () => new Blob(), broken.deps).done;
    expect(broken.lines).toEqual(["P1: paste failed: bad png"]);
  });
});
