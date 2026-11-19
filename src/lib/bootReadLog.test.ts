// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { logBootRead } from "./ipc";

vi.mock("./ipc", () => ({ logBootRead: vi.fn() }));

const send = vi.mocked(logBootRead);

// The module keeps its queue between calls; each test gets a fresh one.
async function fresh() {
  vi.resetModules();
  return (await import("./bootReadLog")).reportBootRead;
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue(undefined);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("reportBootRead thinning", () => {
  it("keeps failed and timeout lines for attempts 1 to 5 and every tenth after", async () => {
    const report = await fresh();
    for (let attempt = 1; attempt <= 31; attempt++) report("roots", "failed", attempt, 1, "x");
    await tick();
    expect(send.mock.calls.map((c) => c[2])).toEqual([1, 2, 3, 4, 5, 10, 20, 30]);
  });

  it("always keeps late and recovered", async () => {
    const report = await fresh();
    report("tracks", "late", 17, 5);
    report("tracks", "recovered", 23, 9);
    await tick();
    expect(send.mock.calls.map((c) => c[1])).toEqual(["late", "recovered"]);
  });
});

describe("reportBootRead delivery", () => {
  it("sends the camelCase fields once, with the error cut and a null when absent", async () => {
    const report = await fresh();
    report("playlists", "failed", 1, 12.6, "e".repeat(1_000));
    report("playlists", "timeout", 2, 40);
    await tick();
    expect(send.mock.calls[0].slice(0, 4)).toEqual(["playlists", "failed", 1, 13]);
    expect((send.mock.calls[0][4] as string).length).toBe(300);
    expect(send.mock.calls[1][4]).toBeNull();
  });

  it("stringifies a non-string rejection", async () => {
    const report = await fresh();
    report("roots", "failed", 1, 1, new Error("nope"));
    await tick();
    expect(send.mock.calls[0][4]).toBe("Error: nope");
  });

  it("never throws or surfaces a failing log call", async () => {
    const report = await fresh();
    send.mockRejectedValue(new Error("ipc down"));
    expect(() => report("roots", "failed", 1, 1, "x")).not.toThrow();
    send.mockImplementation(() => {
      throw new Error("sync fault");
    });
    expect(() => report("roots", "failed", 2, 1, "x")).not.toThrow();
    await tick();
  });

  it("holds lines while the log is down and flushes them in order afterwards", async () => {
    const report = await fresh();
    send.mockRejectedValue(new Error("ipc down"));
    report("roots", "failed", 1, 1, "a");
    report("roots", "failed", 2, 2, "b");
    await tick();
    send.mockReset();
    send.mockResolvedValue(undefined);
    report("roots", "recovered", 3, 3);
    await tick();
    expect(send.mock.calls.map((c) => c[2])).toEqual([1, 2, 3]);
  });

  it("keeps the oldest fifty and drops the newest beyond them", async () => {
    const report = await fresh();
    send.mockRejectedValue(new Error("ipc down"));
    for (let i = 1; i <= 60; i++) report("roots", "recovered", i, i);
    await tick();
    send.mockReset();
    send.mockResolvedValue(undefined);
    report("roots", "recovered", 61, 61);
    await tick();
    expect(send.mock.calls.map((c) => c[2])).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("runs one flush at a time", async () => {
    const report = await fresh();
    let release: () => void = () => {};
    send.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    report("roots", "recovered", 1, 1);
    report("roots", "recovered", 2, 2);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await tick();
    expect(send.mock.calls.map((c) => c[2])).toEqual([1, 2]);
  });
});
