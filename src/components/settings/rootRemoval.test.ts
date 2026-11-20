// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { attemptRemoval } from "./rootRemoval";

const refused = () => Promise.reject(new Error("unfinished writes"));
const files = () => Promise.resolve(["D:\Music\a.opus"]);

describe("attemptRemoval", () => {
  it("is done when the removal succeeds", async () => {
    expect(await attemptRemoval(() => Promise.resolve(), files, false)).toEqual({ kind: "done" });
  });

  it("names the files when refused for unfinished writes", async () => {
    expect(await attemptRemoval(refused, files, false)).toEqual({ kind: "unfinished", files: ["D:\Music\a.opus"] });
  });

  it("fails, with no confirm, when the file names cannot be read", async () => {
    expect(await attemptRemoval(refused, () => Promise.reject(new Error("down")), false)).toEqual({ kind: "failed" });
  });

  it("fails rather than asking again when the retry that drops the writes is refused", async () => {
    const read = vi.fn(files);
    expect(await attemptRemoval(refused, read, true)).toEqual({ kind: "failed" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reports a busy lock by what holds it, and any other error as failed", async () => {
    const reject = (text: string) => () => Promise.reject(new Error(text));
    expect(await attemptRemoval(reject("a file write is running"), files, false)).toEqual({ kind: "fileWrite" });
    expect(await attemptRemoval(reject("a scan is already running"), files, false)).toEqual({ kind: "scan" });
    expect(await attemptRemoval(reject("boom"), files, false)).toEqual({ kind: "failed" });
  });
});
