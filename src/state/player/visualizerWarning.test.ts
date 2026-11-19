// -- Library Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { getSetting, setSetting } from "../../lib/ipc";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";

// -- Unit Imports --
import { useVisualizerDefaults } from "./visualizerDefaults";
import { catalogOf, parseCatalog, serializeCatalog } from "./visualizerCatalog";
import {
  acknowledgeWarning,
  calmOff,
  cozyOnlyRefused,
  isCozyOnly,
  setCalm,
  setCozyOnly,
  resetAcknowledgedHere,
  setVisualizersOff,
  settleWarningKind,
  useSessionKind,
  useWarningSnapshots,
  warningKind,
  warningStatus,
} from "./visualizerWarning";

vi.mock("../../lib/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

const ACK = PREF_KEYS.visualizerWarningAck;
const CATALOG = PREF_KEYS.playerVisualizerCatalog;
const REACT = PREF_KEYS.playerVisualizerReactivity;
const KIND = PREF_KEYS.playerVisualizer;

const prefs = () => usePreferencesStore.getState();
const groupsOff = () => parseCatalog(prefs().values[CATALOG], false).state.groups;
const seed = (values: Record<string, string>, failed: string[] = [], loaded = true) =>
  usePreferencesStore.setState({ values, failedKeys: new Set(failed), loaded });

beforeEach(() => {
  vi.mocked(getSetting).mockReset();
  vi.mocked(setSetting).mockReset().mockResolvedValue(undefined);
  useWarningSnapshots.setState({ groups: null, reactivity: null, kind: null });
  useSessionKind.setState({ kind: null });
  resetAcknowledgedHere();
  seed({});
});

describe("warningStatus", () => {
  it("is unread until the preferences load, whatever else is set", () => {
    expect(warningStatus(false, new Set(), { [ACK]: "1" })).toBe("unread");
  });

  it("is unreadable when the key failed to read, even with a value", () => {
    expect(warningStatus(true, new Set([ACK]), {})).toBe("unreadable");
    expect(warningStatus(true, new Set([ACK]), { [ACK]: "1" })).toBe("unreadable");
  });

  it("is acknowledged only for the value 1", () => {
    expect(warningStatus(true, new Set(), { [ACK]: "1" })).toBe("acknowledged");
  });

  it.each([undefined, "", "0", "true"])("is pending for %j", (value) => {
    expect(warningStatus(true, new Set(), value === undefined ? {} : { [ACK]: value })).toBe("pending");
  });

  it("ignores failures of other keys", () => {
    expect(warningStatus(true, new Set([REACT]), { [ACK]: "1" })).toBe("acknowledged");
  });
});

describe("warningKind", () => {
  it("is first with none of the earlier keys stored", () => {
    expect(warningKind({})).toBe("first");
    expect(warningKind({ [PREF_KEYS.theme]: "dark" })).toBe("first");
  });

  it.each([
    PREF_KEYS.playerVisualizer,
    PREF_KEYS.playerVisualizerCatalog,
    PREF_KEYS.playerVisualizerReactivity,
    PREF_KEYS.playerSpectrumLayout,
    PREF_KEYS.playerResume,
  ])("is update when %s is stored", (key) => {
    expect(warningKind({ [key]: "x" })).toBe("update");
  });
});

describe("boot read of the flag", () => {
  it("retries a failing read and then reads the stored flag", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.mocked(getSetting).mockImplementation(async (key) => {
      if (key !== ACK) return null;
      if (++calls <= 2) throw new Error("not ready");
      return "1";
    });
    const done = prefs().loadPreferences();
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    vi.useRealTimers();
    const s = prefs();
    expect(warningStatus(s.loaded, s.failedKeys, s.values)).toBe("acknowledged");
  });

  it("stays closed as unreadable when every read fails", async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockImplementation(async (key) => {
      if (key === ACK) throw new Error("down");
      return null;
    });
    const done = prefs().loadPreferences();
    await vi.advanceTimersByTimeAsync(60000);
    await done;
    vi.useRealTimers();
    const s = prefs();
    expect(warningStatus(s.loaded, s.failedKeys, s.values)).toBe("unreadable");
  });

  it("resolves to acknowledged when a later retry reads the flag", async () => {
    seed({}, [ACK]);
    vi.mocked(getSetting).mockResolvedValue("1");
    await prefs().retryPreference(ACK);
    const s = prefs();
    expect(warningStatus(s.loaded, s.failedKeys, s.values)).toBe("acknowledged");
  });
});

describe("acknowledgeWarning", () => {
  it("writes the flag", () => {
    seed({});
    acknowledgeWarning();
    expect(prefs().values[ACK]).toBe("1");
    expect(setSetting).toHaveBeenCalledWith(ACK, "1");
  });

  it("clears the key from failedKeys and survives a late retry that reads nothing", async () => {
    seed({}, [ACK, REACT]);
    vi.mocked(getSetting).mockResolvedValue(null);
    const late = prefs().retryPreference(ACK);
    acknowledgeWarning();
    await late;
    const s = prefs();
    expect(s.failedKeys.has(ACK)).toBe(false);
    expect(s.failedKeys.has(REACT)).toBe(true);
    expect(warningStatus(s.loaded, s.failedKeys, s.values)).toBe("acknowledged");
  });

  it("drops the snapshots", () => {
    useWarningSnapshots.setState({ groups: ["fluid"], reactivity: "lively", kind: "ink" });
    acknowledgeWarning();
    expect(useWarningSnapshots.getState()).toEqual({ groups: null, reactivity: null, kind: null });
  });
});

describe("cozyOnlyRefused", () => {
  const cozyKinds = () =>
    catalogOf(undefined, false)
      .entries.filter((e) => e.group === "cozy")
      .map((e) => e.id);

  it("is open for a writable catalog", () => {
    expect(cozyOnlyRefused(catalogOf(undefined, false))).toBe(false);
  });

  it("refuses when the catalog is unreadable", () => {
    expect(cozyOnlyRefused(catalogOf(undefined, true))).toBe(true);
  });

  it("refuses when every Cozy kind is switched off, since the result would offer nothing", () => {
    const raw = serializeCatalog({ kinds: cozyKinds(), groups: [] });
    expect(cozyOnlyRefused(catalogOf(raw, false))).toBe(true);
  });

  it("stays open to switch off once Keep only Cozy is on", () => {
    seed({});
    setCozyOnly(true);
    expect(cozyOnlyRefused(catalogOf(prefs().values[CATALOG], false))).toBe(false);
  });
});

describe("Keep only Cozy", () => {
  it("turns every other family off and cozy on, leaving kinds and unknown ids", () => {
    seed({ [CATALOG]: serializeCatalog({ kinds: ["glass"], groups: ["cozy", "future"] }) });
    setCozyOnly(true);
    const state = parseCatalog(prefs().values[CATALOG], false).state;
    expect(state.kinds).toEqual(["glass"]);
    expect(state.groups).toEqual(["future", "classic", "dots", "fluid", "cyber", "cosmic"]);
    expect(isCozyOnly(catalogOf(prefs().values[CATALOG], false))).toBe(true);
  });

  it("restores a family the user had turned off, exactly, when switched off", () => {
    const before = serializeCatalog({ kinds: [], groups: ["dots"] });
    seed({ [CATALOG]: before });
    setCozyOnly(true);
    setCozyOnly(false);
    expect(prefs().values[CATALOG]).toBe(before);
    expect(useWarningSnapshots.getState().groups).toBeNull();
  });

  it("falls back to every family on, with no snapshot", () => {
    const groups = ["classic", "dots", "fluid", "cyber", "cosmic", "future"];
    seed({ [CATALOG]: serializeCatalog({ kinds: ["glass"], groups }) });
    setCozyOnly(false);
    expect(parseCatalog(prefs().values[CATALOG], false).state).toEqual({ kinds: ["glass"], groups: ["future"] });
  });

  it("keeps the first snapshot when switched on twice", () => {
    const before = serializeCatalog({ kinds: [], groups: ["dots"] });
    seed({ [CATALOG]: before });
    setCozyOnly(true);
    setCozyOnly(true);
    setCozyOnly(false);
    expect(prefs().values[CATALOG]).toBe(before);
  });

  it("writes nothing while the catalog is unreadable", () => {
    seed({}, [CATALOG]);
    setCozyOnly(true);
    setCozyOnly(false);
    expect(prefs().values[CATALOG]).toBeUndefined();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("writes nothing for a catalog written by a newer version", () => {
    const newer = JSON.stringify({ v: 2, kinds: [], groups: [] });
    seed({ [CATALOG]: newer });
    setCozyOnly(true);
    expect(prefs().values[CATALOG]).toBe(newer);
  });

  it("persists through the preferences setter", () => {
    setCozyOnly(true);
    expect(setSetting).toHaveBeenCalledWith(CATALOG, prefs().values[CATALOG]);
  });
});

describe("Reactivity Calm", () => {
  it("sets calm and restores the prior level", () => {
    seed({ [REACT]: "lively" });
    setCalm(true);
    expect(prefs().values[REACT]).toBe("calm");
    setCalm(false);
    expect(prefs().values[REACT]).toBe("lively");
  });

  it("restores the default when the level was unset", () => {
    seed({});
    setCalm(true);
    setCalm(false);
    expect(prefs().values[REACT]).toBe("balanced");
  });

  it("falls back to the default with no snapshot", () => {
    seed({ [REACT]: "calm" });
    setCalm(false);
    expect(prefs().values[REACT]).toBe(calmOff(null));
  });

  it("keeps the snapshot of the level that was replaced when switched on twice", () => {
    seed({ [REACT]: "lively" });
    setCalm(true);
    setCalm(true);
    setCalm(false);
    expect(prefs().values[REACT]).toBe("lively");
  });

  it("writes nothing while the key is unreadable", () => {
    seed({}, [REACT]);
    setCalm(true);
    expect(prefs().values[REACT]).toBeUndefined();
  });
});

describe("Turn visualizers off", () => {
  it("sets off and restores the prior kind", () => {
    seed({ [KIND]: "ink" });
    setVisualizersOff(true);
    expect(prefs().values[KIND]).toBe("off");
    setVisualizersOff(false);
    expect(prefs().values[KIND]).toBe("ink");
  });

  it("falls back to the default kind with no snapshot", () => {
    seed({ [KIND]: "off" });
    setVisualizersOff(false);
    expect(prefs().values[KIND]).toBe("ridge");
  });

  it("does not touch the catalog or any album default", () => {
    seed({ [KIND]: "ink", [CATALOG]: serializeCatalog({ kinds: [], groups: ["dots"] }) });
    setVisualizersOff(true);
    expect(prefs().values[CATALOG]).toBe(serializeCatalog({ kinds: [], groups: ["dots"] }));
  });

  it("drops the temporary override on, and does not bring it back off", () => {
    seed({ [KIND]: "ink" });
    useVisualizerDefaults.setState({ override: { kind: "glass", albumKey: "a" } });
    setVisualizersOff(true);
    expect(useVisualizerDefaults.getState().override).toBeNull();
    setVisualizersOff(false);
    expect(useVisualizerDefaults.getState().override).toBeNull();
  });

  it("writes nothing while the key is unreadable", () => {
    seed({}, [KIND]);
    setVisualizersOff(true);
    expect(prefs().values[KIND]).toBeUndefined();
  });
});

describe("groups helper", () => {
  it("reads the groups the catalog has off", () => {
    seed({ [CATALOG]: serializeCatalog({ kinds: [], groups: ["dots"] }) });
    expect(groupsOff()).toEqual(["dots"]);
  });
});

describe("settleWarningKind", () => {
  const kind = () => {
    const s = prefs();
    return storedKindOf(s.values);
  };
  const storedKindOf = (values: Record<string, string>) => values[ACK];

  it("settles first on a fresh install and keeps it as keys appear", () => {
    seed({});
    settleWarningKind();
    expect(kind()).toBe("first");
    expect(setSetting).toHaveBeenCalledWith(ACK, "first");
    prefs().setPreference(REACT, "calm");
    prefs().setPreference(PREF_KEYS.playerResume, "{}");
    expect(warningStatus(true, new Set(), prefs().values)).toBe("pending");
    expect(kind()).toBe("first");
    // A restart with those keys present reads the stored kind.
    useSessionKind.setState({ kind: null });
    settleWarningKind();
    expect(kind()).toBe("first");
  });

  it.each([PREF_KEYS.playerResume, PREF_KEYS.playerVisualizer, PREF_KEYS.playerSpectrumLayout])(
    "settles update when %s is on disk at the first boot",
    (key) => {
      seed({ [key]: "x" });
      settleWarningKind();
      expect(kind()).toBe("update");
      prefs().setPreference(REACT, "calm");
      expect(kind()).toBe("update");
    },
  );

  it("leaves an acknowledged flag and a stored kind alone", () => {
    seed({ [ACK]: "1", [KIND]: "ink" });
    settleWarningKind();
    expect(kind()).toBe("1");
    seed({ [ACK]: "update" });
    settleWarningKind();
    expect(kind()).toBe("update");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("is a no-op the second time", () => {
    seed({});
    settleWarningKind();
    settleWarningKind();
    expect(setSetting).toHaveBeenCalledTimes(1);
  });

  it("writes nothing while the flag is unreadable and settles after a successful retry", async () => {
    seed({ [KIND]: "ink" }, [ACK]);
    settleWarningKind();
    expect(setSetting).not.toHaveBeenCalled();
    expect(useSessionKind.getState().kind).toBe("update");
    // The keys the notice's switches write do not change the session's answer.
    seed({ [REACT]: "calm" }, [ACK]);
    vi.mocked(getSetting).mockResolvedValue(null);
    await prefs().retryPreference(ACK);
    settleWarningKind();
    expect(setSetting).toHaveBeenCalledWith(ACK, "update");
  });

  it("uses a kind a retry finds stored", async () => {
    seed({}, [ACK]);
    settleWarningKind();
    vi.mocked(getSetting).mockResolvedValue("update");
    await prefs().retryPreference(ACK);
    settleWarningKind();
    expect(kind()).toBe("update");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("does not undo an acknowledgement when a late retry reads a kind", async () => {
    seed({}, [ACK]);
    vi.mocked(getSetting).mockResolvedValue("first");
    const late = prefs().retryPreference(ACK);
    acknowledgeWarning();
    await late;
    expect(kind()).toBe("1");
  });

  it("does nothing before the preferences load", () => {
    seed({}, [], false);
    settleWarningKind();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("keeps an acknowledgement made while a second load is in flight", async () => {
    const disk: Record<string, string> = {};
    vi.mocked(setSetting).mockImplementation(async (key, value) => {
      disk[key] = value;
    });
    vi.mocked(getSetting).mockImplementation(async (key) => disk[key] ?? null);
    seed({}, [], false);
    await prefs().loadPreferences();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(getSetting).mockImplementation(async (key) => {
      const value = disk[key] ?? null;
      await gate;
      return value;
    });
    const second = prefs().loadPreferences().then(settleWarningKind);
    await Promise.resolve();
    acknowledgeWarning();
    release();
    await second;
    expect(prefs().values[ACK]).toBe("1");
    expect(disk[ACK]).toBe("1");
    expect(setSetting).not.toHaveBeenCalledWith(ACK, "first");
  });

  it("never writes a kind once the user acknowledged in this session", () => {
    seed({});
    acknowledgeWarning();
    seed({});
    settleWarningKind();
    expect(setSetting).not.toHaveBeenCalledWith(ACK, "first");
  });
});
