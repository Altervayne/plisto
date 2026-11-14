// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { crashDetail, hubOpensPage, pageState, statusView } from "./statusModel";
import { manifest, row, status } from "./fixtures";

// -- Type Imports --
import type { PluginRow, PluginRuntime, PluginStatus } from "../../types";

const native = (over: Partial<PluginRow> = {}) => row({ id: "tap", tier: "native", ...over });
const view = (s: Partial<PluginStatus>, r: PluginRow = native(), runtime: PluginRuntime = "running") =>
  statusView(runtime, r, status({ id: r.id, ...s }));

describe("statusView, one case per row of the status table", () => {
  it("off: nothing at all", () => {
    expect(view({ host: "off" })).toEqual({
      dot: null,
      tip: null,
      body: { kind: "none" },
      hub: null,
      restart: false,
    });
  });

  it("starting: no dot, the word Starting, the starting card", () => {
    const v = view({ host: "starting" });
    expect(v.dot).toBeNull();
    expect(v.tip).toEqual({ kind: "starting" });
    expect(v.body).toEqual({ kind: "starting" });
    expect(v.hub).toEqual({ kind: "starting" });
    expect(v.restart).toBe(false);
  });

  it("running with no report (a UI plugin): no dot, no words, the frame", () => {
    const v = view({ host: "running", reported: null }, row());
    expect(v.dot).toBeNull();
    expect(v.tip).toBeNull();
    expect(v.hub).toBeNull();
    expect(v.body).toEqual({ kind: "frame" });
  });

  it("running offers Restart for a native plugin and not for a UI plugin", () => {
    expect(view({ host: "running" }).restart).toBe(true);
    expect(view({ host: "running", reported: { state: "on", text: "Mirroring" } }).restart).toBe(true);
    expect(view({ host: "running" }, row()).restart).toBe(false);
  });

  it("running and idle: grey with the reported text", () => {
    const v = view({ reported: { state: "idle", text: "Paused" } });
    expect(v.dot).toBe("idle");
    expect(v.tip).toEqual({ kind: "reported", text: "Paused" });
    expect(v.hub).toEqual({ kind: "reported", text: "Paused" });
    expect(v.body).toEqual({ kind: "frame" });
  });

  it("running and on: cyan with the reported text", () => {
    expect(view({ reported: { state: "on", text: "Mirroring to 3 devices" } }).dot).toBe("on");
  });

  it("running and warn: amber with the reported text", () => {
    const v = view({ reported: { state: "warn", text: "No tap" } });
    expect(v.dot).toBe("warn");
    expect(v.tip).toEqual({ kind: "reported", text: "No tap" });
  });

  it("running with a report that has no text: the dot, no words", () => {
    const v = view({ reported: { state: "on", text: null } });
    expect(v.dot).toBe("on");
    expect(v.tip).toBeNull();
    expect(v.hub).toBeNull();
  });

  it("takeover wins over idle and warn for the dot", () => {
    expect(view({ takeover: true, reported: { state: "idle", text: "Paused" } }).dot).toBe("on");
    expect(view({ takeover: true, reported: { state: "warn", text: "No tap" } }).dot).toBe("on");
    expect(view({ takeover: true, reported: null }).dot).toBe("on");
  });

  it("not responding: amber, the overlay, Restart in the hub", () => {
    const v = view({ host: "not_responding" });
    expect(v.dot).toBe("warn");
    expect(v.tip).toEqual({ kind: "notResponding" });
    expect(v.body).toEqual({ kind: "notResponding", takeoverLine: false });
    expect(v.hub).toEqual({ kind: "notResponding" });
    expect(v.restart).toBe(true);
  });

  it("not responding after a revoked takeover adds the speakers line", () => {
    const v = view({ host: "not_responding", takeover_revoked: "not_responding" });
    expect(v.body).toEqual({ kind: "notResponding", takeoverLine: true });
    expect(view({ host: "not_responding", takeover_revoked: "user" }).body).toEqual({
      kind: "notResponding",
      takeoverLine: false,
    });
  });

  it("restarting: amber, stopped words, the restarting card, no Restart", () => {
    const v = view({ host: "restarting", retry_in_ms: 1000 });
    expect(v.dot).toBe("warn");
    expect(v.tip).toEqual({ kind: "stopped" });
    expect(v.body).toEqual({ kind: "restarting" });
    expect(v.hub).toEqual({ kind: "restarting" });
    expect(v.restart).toBe(false);
  });

  it("stopped: amber, the crash card with Restart in the hub", () => {
    const v = view({ host: "stopped" });
    expect(v.dot).toBe("warn");
    expect(v.tip).toEqual({ kind: "stopped" });
    expect(v.body).toEqual({ kind: "stopped" });
    expect(v.hub).toEqual({ kind: "stopped" });
    expect(v.restart).toBe(true);
  });

  it("crash loop: no dot, the page gone, the sentence in the hub (the row is already off)", () => {
    const v = view({ host: "crash_loop" }, native({ enabled: false }));
    expect(v.dot).toBeNull();
    expect(v.tip).toBeNull();
    expect(v.body).toEqual({ kind: "gone" });
    expect(v.hub).toEqual({ kind: "crashLoop" });
  });

  it("failed: amber, could not start, the reason in the card and the hub", () => {
    const v = view({ host: "failed", reason: "changed" });
    expect(v.dot).toBe("warn");
    expect(v.tip).toEqual({ kind: "failed" });
    expect(v.body).toEqual({ kind: "failed", reason: "changed" });
    expect(v.hub).toEqual({ kind: "failed", reason: "changed" });
  });

  it("held and safe show nothing, whatever the status says", () => {
    const loud = { host: "not_responding" as const, takeover: true };
    for (const runtime of ["held", "safe"] as const) {
      expect(view(loud, native(), runtime).dot).toBeNull();
      expect(view(loud, native(), runtime).hub).toBeNull();
    }
    expect(statusView(null, native(), status({ host: "stopped" })).dot).toBeNull();
  });

  it("shows nothing without a status or for a plugin that is off", () => {
    expect(statusView("running", native(), undefined).dot).toBeNull();
    expect(view({ host: "running", takeover: true }, native({ enabled: false })).dot).toBeNull();
  });
});

describe("pageState", () => {
  const stopped = statusView("running", row(), status({ host: "stopped" }));
  const running = statusView("running", row(), status({ host: "running" }));

  it("takes a native plugin's body from the status alone", () => {
    expect(pageState(stopped, false, undefined).body).toEqual({ kind: "stopped" });
  });

  it("lets a frame's own phase decide for a UI plugin", () => {
    expect(pageState(running, true, "loading").body).toEqual({ kind: "starting" });
    expect(pageState(running, true, "live").body).toEqual({ kind: "frame" });
    expect(pageState(running, true, "crashed").body).toEqual({ kind: "stopped" });
    expect(pageState(running, true, "not_responding").head).toEqual({ kind: "notResponding" });
  });

  it("waits for a restart's fresh frame instead of showing a stale stopped state", () => {
    expect(pageState(stopped, true, "loading").body).toEqual({ kind: "starting" });
  });

  it("keeps Rust's restarting for a UI plugin whose frame is gone", () => {
    const restarting = statusView("running", row(), status({ host: "restarting", retry_in_ms: 1 }));
    expect(pageState(restarting, true, "crashed").body).toEqual({ kind: "restarting" });
  });
});

describe("crashDetail", () => {
  it("prints the exit code as eight hex digits and the local time", () => {
    const at = new Date(2026, 10, 14, 14, 22, 8).getTime();
    expect(crashDetail({ reason: "exited", exit_code: 3, at_ms: at }, null)).toEqual({
      reason: "exited",
      code: "0x00000003",
      time: "14:22:08",
    });
    expect(crashDetail({ reason: "exited", exit_code: 0xc0000005, at_ms: at }, null)?.code).toBe("0xC0000005");
  });

  it("has no code when the process left none, and falls back to a frame's own reason", () => {
    expect(crashDetail({ reason: "protocol", exit_code: null, at_ms: 0 }, null)?.code).toBeNull();
    expect(crashDetail(null, "silent")).toEqual({ reason: "silent", code: null, time: null });
    expect(crashDetail(null, null)).toBeNull();
  });
});

describe("hubOpensPage", () => {
  const RUNNING = { runtime: "running", unclean: false, safe_flag: false } as const;
  const opens = (r: PluginRow) => hubOpensPage(RUNNING, r, [r], "both");

  it("offers a live UI plugin and a live native plugin with a page", () => {
    expect(opens(row())).toBe(true);
    expect(opens(native({ manifest: manifest({ page: "page/index.html" }) }))).toBe(true);
  });

  it("does not offer a native plugin without a page", () => {
    expect(opens(native())).toBe(false);
  });

  it("does not offer a plugin that is off, not ready or hidden by the app mode", () => {
    expect(opens(row({ enabled: false }))).toBe(false);
    expect(opens(row({ state: "needs_consent" }))).toBe(false);
    const paged = native({ manifest: manifest({ page: "page/index.html", modes: ["player"] }) });
    expect(hubOpensPage(RUNNING, paged, [paged], "organizer")).toBe(false);
    expect(hubOpensPage(RUNNING, paged, [], "both")).toBe(false);
  });

  it("does not offer anything in safe mode, while the boot offer is held or before boot is read", () => {
    const r = row();
    expect(hubOpensPage({ runtime: "safe", unclean: false, safe_flag: true }, r, [r], "both")).toBe(false);
    expect(hubOpensPage({ runtime: "held", unclean: true, safe_flag: false }, r, [r], "both")).toBe(false);
    expect(hubOpensPage(null, r, [r], "both")).toBe(false);
  });
});
