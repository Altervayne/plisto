// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("./ipc", () => ({
  pluginsShutdownForUpdate: vi.fn(() => {
    calls.push("shutdown");
    return Promise.resolve();
  }),
  pluginsResumeAfterUpdate: vi.fn(() => {
    calls.push("resume");
    return Promise.resolve();
  }),
}));

// -- Unit Imports --
import { installUpdate } from "./updater";

// -- IPC Imports --
import { pluginsShutdownForUpdate } from "./ipc";

// -- Type Imports --
import type { Update } from "@tauri-apps/plugin-updater";

const update = (download: () => Promise<void>, install: () => Promise<void>) =>
  ({
    download: vi.fn(() => {
      calls.push("download");
      return download();
    }),
    install: vi.fn(() => {
      calls.push("install");
      return install();
    }),
  }) as unknown as Update;

const ok = () => Promise.resolve();

beforeEach(() => {
  calls.length = 0;
});

describe("installUpdate", () => {
  it("stops the plugins after the download and before the install", async () => {
    await installUpdate(update(ok, ok), () => {});
    expect(calls).toEqual(["download", "shutdown", "install"]);
  });

  it("never stops the plugins when the download fails", async () => {
    const failing = update(() => Promise.reject(new Error("offline")), ok);
    await expect(installUpdate(failing, () => {})).rejects.toThrow("offline");
    expect(calls).toEqual(["download"]);
  });

  it("starts the plugins again when the install fails, and rethrows", async () => {
    const failing = update(ok, () => Promise.reject(new Error("disk full")));
    await expect(installUpdate(failing, () => {})).rejects.toThrow("disk full");
    expect(calls).toEqual(["download", "shutdown", "install", "resume"]);
  });

  it("installs even when the shutdown is refused", async () => {
    vi.mocked(pluginsShutdownForUpdate).mockRejectedValueOnce(new Error("no"));
    await installUpdate(update(ok, ok), () => {});
    expect(calls).toEqual(["download", "install"]);
  });
});
