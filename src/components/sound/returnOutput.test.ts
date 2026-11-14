// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { returnOutput } from "./returnOutput";

// -- State Imports --
import { currentPluginNotice, resetPluginNotice } from "../../state/plugins/pluginNotice";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => resetPluginNotice());

describe("returnOutput", () => {
  it("calls the command once and raises the notice with the holder after a release", async () => {
    const release = vi.fn(async () => true);
    expect(await returnOutput(release, "tandem")).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(currentPluginNotice()).toEqual({ notice: { id: "tandem", kind: "takeover_returned" }, visible: true });
  });

  it("raises the nameless notice when no holder is known", async () => {
    await returnOutput(async () => true, null);
    expect(currentPluginNotice().notice).toEqual({ id: null, kind: "takeover_returned" });
  });

  it("raises nothing when nothing was released", async () => {
    expect(await returnOutput(async () => false, "tandem")).toBe(false);
    expect(currentPluginNotice().notice).toBeNull();
  });

  it("raises nothing when the command rejects", async () => {
    expect(await returnOutput(() => Promise.reject(new Error("denied")), "tandem")).toBe(false);
    expect(currentPluginNotice().notice).toBeNull();
  });
});
