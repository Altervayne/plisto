// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  pluginApprove: vi.fn(),
  pluginDiscard: vi.fn(),
  pluginEnable: vi.fn(),
  pluginInspect: vi.fn(),
  pluginInstall: vi.fn(),
  pluginUpdate: vi.fn(),
  pluginIcon: vi.fn(),
  pluginStagedIcon: vi.fn(),
}));
const reloadPlugins = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", () => ipc);
vi.mock("./usePluginsSync", () => ({ reloadPlugins }));

// -- Unit Imports --
import { createReviewFlow } from "./reviewFlow";
import { createLock } from "./operationLock";
import { usePluginsStore } from "./store";
import { inspection, row } from "./fixtures";

// -- Type Imports --
import type { ReviewFlow } from "./reviewFlow";
import type { NoticeState, ReviewState } from "./sheet";

const pending = (over = {}) => row({ state: "needs_consent", enabled: false, granted: [], ...over });
const ready = (over = {}) => row({ enabled: false, ...over });

let flow: ReviewFlow;
const review = () => flow.getSheet() as ReviewState;
const notice = () => flow.getSheet() as NoticeState;

beforeEach(() => {
  Object.values(ipc).forEach((fn) => fn.mockReset());
  ipc.pluginDiscard.mockResolvedValue(undefined);
  reloadPlugins.mockReset().mockResolvedValue(true);
  usePluginsStore.setState({ rows: [], boot: null, status: "ready", epoch: 0 });
  flow = createReviewFlow(createLock());
});

/** Opens the install review of a fresh plugin. */
async function openInstall(over = {}) {
  ipc.pluginInspect.mockResolvedValue(inspection({ installed: null, ...over }));
  await flow.inspect("C:\\x\\lyrics.plistoplugin");
}

describe("a new install", () => {
  it("installs then approves, leaving a ready row that is off, and never enables", async () => {
    await openInstall();
    expect(review().mode).toBe("install");
    ipc.pluginInstall.mockResolvedValue(pending({ manifest_hash: "h-new" }));
    ipc.pluginApprove.mockResolvedValue(ready({ manifest_hash: "h-new" }));
    await flow.confirm(false);
    expect(ipc.pluginApprove).toHaveBeenCalledWith("lyrics", ["playback.read", "library.read", "network"], undefined, "h-new");
    expect(ipc.pluginEnable).not.toHaveBeenCalled();
    expect(flow.getSheet()).toBeNull();
    const stored = usePluginsStore.getState().rows[0];
    expect(stored.state).toBe("ready");
    expect(stored.enabled).toBe(false);
  });

  it("sends the native acknowledgement for a native plugin", async () => {
    await openInstall({ tier: "native", native_reason: "Needs devices." });
    ipc.pluginInstall.mockResolvedValue(pending({ tier: "native", manifest_hash: "h" }));
    ipc.pluginApprove.mockResolvedValue(ready());
    await flow.confirm(true);
    expect(ipc.pluginApprove.mock.calls[0][2]).toBe(true);
  });

  it("says it stayed installed and needs review when approve is refused", async () => {
    await openInstall();
    ipc.pluginInstall.mockResolvedValue(pending());
    ipc.pluginApprove.mockRejectedValue({ code: "io", detail: "disk" });
    await flow.confirm(false);
    expect(notice()).toMatchObject({ kind: "notice", notice: "approve", error: "io" });
    expect(usePluginsStore.getState().rows[0].state).toBe("needs_consent");
    flow.close();
    expect(flow.getSheet()).toBeNull();
  });

  it("reopens the review on the fresh hash when approve finds the manifest changed", async () => {
    await openInstall();
    ipc.pluginInstall.mockResolvedValue(pending({ manifest_hash: "old" }));
    ipc.pluginApprove.mockRejectedValue({ code: "manifest_changed", detail: "" });
    reloadPlugins.mockImplementation(async () => {
      usePluginsStore.getState().applyRows([pending({ manifest_hash: "fresh" })]);
      return true;
    });
    await flow.confirm(false);
    expect(review()).toMatchObject({ mode: "consent", hash: "fresh", lead: "changed", phase: "idle" });
  });
});

describe("an update", () => {
  const installedRow = () => row({ enabled: true });

  it("opens a second review when the update comes back needing consent", async () => {
    usePluginsStore.getState().applyRows([installedRow()]);
    await openInstall({ installed: "1.3.0" });
    expect(review().mode).toBe("update");
    ipc.pluginUpdate.mockResolvedValue({ row: pending({ manifest_hash: "h2", version: "1.4.0" }), previous_version: "1.3.0" });
    await flow.confirm(false);
    expect(review()).toMatchObject({ mode: "consent", hash: "h2", lead: "updated", phase: "idle", token: null });
    expect(review().subject.previous?.version).toBe("1.3.0");
  });

  it("closes when the update keeps consent", async () => {
    usePluginsStore.getState().applyRows([installedRow()]);
    await openInstall({ installed: "1.3.0" });
    ipc.pluginUpdate.mockResolvedValue({ row: installedRow(), previous_version: "1.3.0" });
    await flow.confirm(false);
    expect(flow.getSheet()).toBeNull();
  });

  it("ends in a closable notice when the updated plugin cannot be read for review", async () => {
    usePluginsStore.getState().applyRows([installedRow()]);
    await openInstall({ installed: "1.3.0" });
    ipc.pluginUpdate.mockResolvedValue({ row: pending({ manifest: null }), previous_version: "1.3.0" });
    await flow.confirm(false);
    expect(notice().notice).toBe("updatedUnreadable");
    flow.close();
    expect(flow.getSheet()).toBeNull();
  });

  it("shows the refusal and discards the staged copy", async () => {
    usePluginsStore.getState().applyRows([installedRow()]);
    await openInstall({ installed: "1.3.0" });
    ipc.pluginUpdate.mockRejectedValue({ code: "tier_changed", detail: "" });
    await flow.confirm(false);
    expect(notice()).toMatchObject({ notice: "update", error: "tier_changed" });
    expect(ipc.pluginDiscard).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unregistered folder as an update", async () => {
    await openInstall({ installed: "" });
    expect(notice().notice).toBe("unregistered");
    expect(ipc.pluginDiscard).toHaveBeenCalledWith("tok");
  });
});

describe("reviewing an installed plugin that needs consent", () => {
  const open = (r = pending({ manifest_hash: "h1" })) => {
    usePluginsStore.getState().applyRows([r]);
    expect(flow.openReview(r)).toBe(true);
  };

  it("enables with the grants and the hash it showed", async () => {
    open();
    ipc.pluginEnable.mockResolvedValue(row({ manifest_hash: "h1" }));
    await flow.confirm(false);
    expect(ipc.pluginEnable).toHaveBeenCalledWith("lyrics", ["playback.read", "network"], undefined, "h1");
    expect(flow.getSheet()).toBeNull();
  });

  it("reloads and reopens on the fresh hash when the manifest changed", async () => {
    open();
    ipc.pluginEnable.mockRejectedValue({ code: "manifest_changed", detail: "" });
    reloadPlugins.mockImplementation(async () => {
      usePluginsStore.getState().applyRows([pending({ manifest_hash: "h2" })]);
      return true;
    });
    await flow.confirm(false);
    expect(review()).toMatchObject({ hash: "h2", lead: "changed", phase: "idle" });
    expect(ipc.pluginEnable).toHaveBeenCalledTimes(1);
  });

  it("ends in a closable notice when the reloaded plugin has no readable manifest", async () => {
    open();
    ipc.pluginEnable.mockRejectedValue({ code: "busy", detail: "" });
    reloadPlugins.mockImplementation(async () => {
      usePluginsStore.getState().applyRows([pending({ manifest: null })]);
      return true;
    });
    await flow.confirm(false);
    expect(notice().notice).toBe("unreadable");
    flow.close();
    expect(flow.getSheet()).toBeNull();
  });

  it("ends in a notice, not a review of old data, when the reload fails", async () => {
    open();
    ipc.pluginEnable.mockRejectedValue({ code: "manifest_changed", detail: "" });
    reloadPlugins.mockResolvedValue(false);
    await flow.confirm(false);
    expect(notice().notice).toBe("stale");
    flow.close();
    expect(flow.getSheet()).toBeNull();
  });

  it("returns false when the manifest cannot be read, opening nothing", () => {
    expect(flow.openReview(pending({ manifest: null }))).toBe(false);
    expect(flow.getSheet()).toBeNull();
  });
});

describe("the staged copy", () => {
  it("is discarded once on cancel, and a second close does nothing", async () => {
    await openInstall();
    flow.close();
    flow.close();
    expect(ipc.pluginDiscard).toHaveBeenCalledTimes(1);
    expect(ipc.pluginDiscard).toHaveBeenCalledWith("tok");
  });

  it("is never discarded after a successful install", async () => {
    await openInstall();
    ipc.pluginInstall.mockResolvedValue(pending());
    ipc.pluginApprove.mockRejectedValue({ code: "io", detail: "" });
    await flow.confirm(false);
    flow.close();
    expect(ipc.pluginDiscard).not.toHaveBeenCalled();
  });

  it("is discarded when the flow goes away with its sheet open", async () => {
    await openInstall();
    flow.dispose();
    expect(ipc.pluginDiscard).toHaveBeenCalledWith("tok");
  });

  it("is discarded when an inspection arrives after the flow went", async () => {
    let arrive!: (i: unknown) => void;
    ipc.pluginInspect.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const started = flow.inspect("C:\\x");
    flow.dispose();
    arrive(inspection({ token: "late" }));
    await started;
    expect(ipc.pluginDiscard).toHaveBeenCalledWith("late");
    expect(flow.getSheet()).toBeNull();
  });
});

describe("one operation at a time", () => {
  it("refuses an inspect while an install is running, without calling the backend", async () => {
    await openInstall();
    let finish!: (r: unknown) => void;
    ipc.pluginInstall.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    ipc.pluginApprove.mockResolvedValue(ready());
    const running = flow.confirm(false);
    expect(review().phase).toBe("installing");
    ipc.pluginInspect.mockClear();
    await flow.inspect("C:\\other");
    expect(ipc.pluginInspect).not.toHaveBeenCalled();
    flow.close();
    expect(ipc.pluginDiscard).not.toHaveBeenCalled();
    expect(flow.getSheet()).not.toBeNull();
    finish(pending());
    await running;
  });

  it("ignores a second confirm while the first runs", async () => {
    await openInstall();
    let finish!: (r: unknown) => void;
    ipc.pluginInstall.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    ipc.pluginApprove.mockResolvedValue(ready());
    const first = flow.confirm(false);
    await flow.confirm(false);
    finish(pending());
    await first;
    expect(ipc.pluginInstall).toHaveBeenCalledTimes(1);
  });
});

describe("a refused inspect", () => {
  it("names the file in a notice with the refusal", async () => {
    ipc.pluginInspect.mockRejectedValue({ code: "bad_archive", detail: "zip" });
    await flow.inspect("C:\\plugins\\broken.plistoplugin");
    expect(notice()).toMatchObject({ notice: "install", name: "broken.plistoplugin", error: "bad_archive" });
  });
});
