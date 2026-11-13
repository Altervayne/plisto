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

const found = (version: string) => ({
  version,
  currentVersion: "2.4.0",
  date: "2026-11-12T10:00:00Z",
  body: "Notes",
  close: async () => {},
});

const downloading = {
  kind: "downloading" as const,
  update: { version: "2.5.0", currentVersion: "2.4.0", notes: "", date: null },
  progress: 0.2,
};

beforeEach(() => {
  checkForUpdate.mockReset();
  useUpdaterStore.setState({ state: IDLE, promptOpen: false, details: null });
  usePreferencesStore.setState({ values: {} });
});

describe("updater store", () => {
  it("prompts after a startup check that finds a fresh version", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("keeps a skipped version quiet at startup, but not a newer one", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.updaterSkipped]: "2.5.0" } });
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().state.kind).toBe("available");
    expect(useUpdaterStore.getState().promptOpen).toBe(false);

    useUpdaterStore.setState({ state: IDLE });
    checkForUpdate.mockResolvedValue(found("2.6.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("opens a skipped version on a manual check", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.updaterSkipped]: "2.5.0" } });
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("manual");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("runs a manual check with auto-check off", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.updaterAutoCheck]: "0" } });
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("manual");
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("closes on Later and writes nothing", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().later();
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    expect(usePreferencesStore.getState().values).toEqual({});
  });

  it("persists the version on Skip and closes", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().skip();
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    expect(usePreferencesStore.getState().values[PREF_KEYS.updaterSkipped]).toBe("2.5.0");
  });

  it("prompts again for a version newer than the one skipped", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().skip();
    useUpdaterStore.setState({ state: IDLE });
    checkForUpdate.mockResolvedValue(found("2.5.1"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("carries the running version and the release date into the announced update", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    expect(useUpdaterStore.getState().state).toEqual({
      kind: "available",
      update: { version: "2.5.0", currentVersion: "2.4.0", notes: "Notes", date: "2026-11-12T10:00:00Z" },
    });
  });

  it("opens the details modal only when an update is announced", async () => {
    useUpdaterStore.getState().openDetails("settings");
    expect(useUpdaterStore.getState().details).toBeNull();
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().openDetails("prompt");
    expect(useUpdaterStore.getState().details).toBe("prompt");
  });

  it("closes the modal without deciding anything, leaving the prompt up", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().openDetails("prompt");
    useUpdaterStore.getState().closeDetails();
    expect(useUpdaterStore.getState().details).toBeNull();
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
    expect(usePreferencesStore.getState().values).toEqual({});
  });

  it("closes the modal and the prompt on Later, writing nothing", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().openDetails("prompt");
    useUpdaterStore.getState().later();
    expect(useUpdaterStore.getState().details).toBeNull();
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    expect(usePreferencesStore.getState().values).toEqual({});
  });

  it("stores the version and closes the modal and the prompt on Skip", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().openDetails("prompt");
    useUpdaterStore.getState().skip();
    expect(useUpdaterStore.getState().details).toBeNull();
    expect(useUpdaterStore.getState().promptOpen).toBe(false);
    expect(usePreferencesStore.getState().values[PREF_KEYS.updaterSkipped]).toBe("2.5.0");
  });

  it("keeps the modal and the prompt through Later while a download runs", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().openDetails("prompt");
    useUpdaterStore.setState({ state: downloading });
    useUpdaterStore.getState().later();
    expect(useUpdaterStore.getState().details).toBe("prompt");
    expect(useUpdaterStore.getState().promptOpen).toBe(true);
  });

  it("drops an open modal when a new check starts", async () => {
    checkForUpdate.mockResolvedValue(found("2.5.0"));
    await useUpdaterStore.getState().check("startup");
    useUpdaterStore.getState().openDetails("settings");
    const pending = useUpdaterStore.getState().check("manual");
    expect(useUpdaterStore.getState().details).toBeNull();
    await pending;
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
