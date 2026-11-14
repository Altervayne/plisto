// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server renderer reads a store's initial state, so the hooks the section reads are controllable values.
let outcome: SandboxCheckState["outcome"] = "pending";
let rows: PluginRow[] = [];
const runSandboxCheck = vi.fn();
vi.mock("./sandboxStore", async (orig) => {
  const real = await orig<typeof import("./sandboxStore")>();
  return {
    ...real,
    useProbe: () => probeOutcome(outcome),
    useSandboxLeaking: () => outcome === "leaking",
  };
});
vi.mock("./store", async (orig) => ({
  ...(await orig<typeof import("./store")>()),
  usePlugins: () => rows,
  usePluginsStatus: () => "ready",
}));
vi.mock("./sandboxCheck", () => ({ runSandboxCheck: (...a: unknown[]) => runSandboxCheck(...a) }));
vi.mock("../../lib/ipc", () => ({
  pluginDataSize: vi.fn(),
  pluginInboxPath: vi.fn(),
  pluginNetEnvironment: vi.fn(),
}));
vi.mock("../../components/settings/plugins/useOperationLock", () => ({
  useOperationLock: () => ({ busy: false, run: vi.fn() }),
}));
vi.mock("../../components/settings/plugins/useReviewFlow", () => ({
  useReviewFlow: () => ({ sheet: null, openReview: vi.fn(), inspect: vi.fn(), confirm: vi.fn(), close: vi.fn() }),
}));
vi.mock("../../lib/dialog", () => ({ pickFolder: vi.fn(), pickPluginFile: vi.fn() }));
vi.mock("../../lib/updater", () => ({ appVersion: () => new Promise(() => {}) }));

// -- Unit Imports --
import { resetSandboxCheck, selectLeaking, selectProbe, startSandboxCheck, useSandboxStore } from "./sandboxStore";
import { manifest, row } from "./fixtures";
import { PluginsSection } from "../../components/settings/plugins/PluginsSection";
import { rowView } from "../../components/settings/plugins/rowModel";
import { probeOutcome } from "./trust";

// -- Type Imports --
import type { SandboxCheckState } from "./sandboxStore";
import type { PluginRow } from "../../types";

// -- i18n Imports --
import { en } from "../../i18n/en";

const line = en.plugins.sandboxLeak.replace("'", "&#x27;");
const render = () => renderToStaticMarkup(<PluginsSection />);

beforeEach(() => {
  runSandboxCheck.mockReset();
  resetSandboxCheck();
  outcome = "pending";
  rows = [row({ tier: "ui", manifest: manifest({ name: "Lyrics" }) })];
});

describe("the selectors behind useProbe and useSandboxLeaking", () => {
  it.each([
    ["leaking", "not_passed", true],
    ["passed", "passed", false],
    ["pending", "passed", false],
    ["unverified", "passed", false],
  ] as const)("reads %s from the store as %s", (value, probe, leaking) => {
    useSandboxStore.setState({ outcome: value });
    expect(selectProbe(useSandboxStore.getState())).toBe(probe);
    expect(selectLeaking(useSandboxStore.getState())).toBe(leaking);
  });
});

describe("startSandboxCheck", () => {
  it("runs once and stores the outcome and counts", async () => {
    runSandboxCheck.mockResolvedValue({ outcome: "leaking", udp: 3, tcp: 0 });
    await startSandboxCheck();
    await startSandboxCheck();
    expect(runSandboxCheck).toHaveBeenCalledTimes(1);
    expect(useSandboxStore.getState()).toEqual({ outcome: "leaking", udp: 3, tcp: 0 });
  });
});

describe("the hub and its rows by outcome", () => {
  it("shows the Unsandboxed tag and the line when leaking", () => {
    outcome = "leaking";
    const html = render();
    expect(html).toContain(en.plugins.tagUnsandboxed);
    expect(html).toContain(line);
    expect(rowView(rows[0], probeOutcome("leaking")).tag).toBe("unsandboxed");
  });

  it.each(["passed", "pending", "unverified"] as const)("shows neither when %s", (value) => {
    outcome = value;
    const html = render();
    expect(html).not.toContain(en.plugins.tagUnsandboxed);
    expect(html).not.toContain(line);
  });
});
