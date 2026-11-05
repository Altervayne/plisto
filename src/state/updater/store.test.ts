// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useUpdaterStore } from "./store";
import { IDLE } from "./machine";
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";

// The plugin seam and the kv writes, stubbed so a test drives what a check answers.
const { checkForUpdate } = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));
vi.mock("../../lib/updater", () => ({
  checkForUpdate,
  installUpdate: vi.fn(),
  relaunchApp: vi.fn(),
  releaseUpdate: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

const found = (version: string) => ({ version, body: "Notes", close: async () => {} });

beforeEach(() => {
  checkForUpdate.mockReset();
  useUpdaterStore.setState({ state: IDLE, promptOpen: false });
  usePreferencesStore.setState({ values: {} });
});

describe("updater store", () => {
  it("prompts after a startup check that finds a fresh version", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("keeps a dismissed version quiet at startup, but not a newer one", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.updaterDismissed]: "2.5.0" } });
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().state.kind).toBe("available");
    expect(useUpdaterStore.getState().promptOpen).toBe(false);

    useUpdaterStore.setState({ state: IDLE });
    checkForUpdate.mockResolvedValue(found("2.6.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("opens a dismissed version on a manual check", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.updaterDismissed]: "2.5.0" } });
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("manual");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("records the version on Later", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().later();
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    expect(usePreferencesStore.getState().values[PREF_KEYS.updaterDismissed]).toBe("2.5.0");
  });

  it("reports a failed manual check as an error, never up to date", async () => {
    checkForUpdate.mockRejectedValue("Could not fetch a valid release JSON from the remote");
    await useUpdaterStore.getState().check("manual");
    expect(useUpdaterStore.getState().state.kind).toBe("error");
  });

  it("drops a failed startup check silently, without claiming up to date", async () => {
    checkForUpdate.mockRejectedValue("offline");
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().state).toEqual(IDLE);
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
  });
});
