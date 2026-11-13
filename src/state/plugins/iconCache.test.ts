// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pluginIcon, pluginStagedIcon } = vi.hoisted(() => ({
  pluginIcon: vi.fn(),
  pluginStagedIcon: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ pluginIcon, pluginStagedIcon }));

// -- Unit Imports --
import { dropInstalledIcons, dropStagedIcon, loadIcon } from "./iconCache";

const PNG = "data:image/png;base64,AAAA";
const installed = (id: string, hash = "h1") => ({ kind: "installed" as const, id, hash });

beforeEach(() => {
  pluginIcon.mockReset();
  pluginStagedIcon.mockReset();
  dropInstalledIcons("a");
  dropInstalledIcons("b");
  dropStagedIcon("t1");
});

describe("icon cache", () => {
  it("reads an icon once per id and hash", async () => {
    pluginIcon.mockResolvedValue(PNG);
    expect(await loadIcon(installed("a"))).toBe(PNG);
    await loadIcon(installed("a"));
    expect(pluginIcon).toHaveBeenCalledTimes(1);
    await loadIcon(installed("a", "h2"));
    expect(pluginIcon).toHaveBeenCalledTimes(2);
  });

  it("returns only image data URLs", async () => {
    pluginIcon.mockResolvedValue("https://evil.example/x.png");
    expect(await loadIcon(installed("a"))).toBeNull();
    pluginStagedIcon.mockResolvedValue("data:text/html;base64,AAAA");
    expect(await loadIcon({ kind: "staged", token: "t1" })).toBeNull();
  });

  it("keeps a null answer but not a rejected read", async () => {
    pluginIcon.mockResolvedValueOnce(null);
    expect(await loadIcon(installed("a"))).toBeNull();
    await loadIcon(installed("a"));
    expect(pluginIcon).toHaveBeenCalledTimes(1);

    pluginIcon.mockRejectedValueOnce(new Error("io")).mockResolvedValue(PNG);
    expect(await loadIcon(installed("b"))).toBeNull();
    expect(await loadIcon(installed("b"))).toBe(PNG);
  });

  it("forgets every hash of a plugin when it is updated or removed", async () => {
    pluginIcon.mockResolvedValue(PNG);
    await loadIcon(installed("a", "h1"));
    await loadIcon(installed("a", "h2"));
    await loadIcon(installed("b"));
    dropInstalledIcons("a");
    await loadIcon(installed("a", "h1"));
    await loadIcon(installed("b"));
    expect(pluginIcon).toHaveBeenCalledTimes(4);
  });

  it("forgets a staged token's icon when its sheet closes", async () => {
    pluginStagedIcon.mockResolvedValue(PNG);
    await loadIcon({ kind: "staged", token: "t1" });
    dropStagedIcon("t1");
    await loadIcon({ kind: "staged", token: "t1" });
    expect(pluginStagedIcon).toHaveBeenCalledTimes(2);
  });
});
