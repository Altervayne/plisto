/*
 * The photosensitivity gate: whether the user has acknowledged the flash warning, and the three
 * reversible choices the notice offers. Only an acknowledged flag opens the gate: a read that failed or
 * has not landed keeps it closed, and a failed read is never mistaken for an acknowledgement. Each
 * choice remembers the value it replaced, in memory only, so switching it off puts that value back.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import {
  PREF_KEYS,
  persistVisualizerCatalog,
  selectCatalogUnreadable,
  usePreferencesStore,
} from "../preferences/store";
import { useVisualizerDefaults } from "./visualizerDefaults";
import {
  allGroupsOn,
  catalogOf,
  isOnlyGroup,
  keepOnlyGroup,
  type Catalog,
  type CatalogState,
} from "./visualizerCatalog";
import {
  DEFAULT_REACTIVITY,
  DEFAULT_VISUALIZER,
  normalizeReactivity,
  normalizeVisualizerKind,
  type Reactivity,
  type VisualizerKind,
} from "./visualizerKind";

export type WarningStatus = "unread" | "unreadable" | "acknowledged" | "pending";

/** Whether the notice is for a first-time user or one who used the Player under an older build. */
export type WarningKind = "first" | "update";

const ACK_KEY = PREF_KEYS.visualizerWarningAck;

// Keys a user of an older build has stored once they have used the Player.
const PRIOR_USE_KEYS: readonly string[] = [
  PREF_KEYS.playerVisualizer,
  PREF_KEYS.playerVisualizerCatalog,
  PREF_KEYS.playerVisualizerReactivity,
  PREF_KEYS.playerSpectrumLayout,
  PREF_KEYS.playerResume,
];

const COZY = "cozy";

/**
 * The gate's state from the preferences cache. Only `acknowledged` opens it. The flag holds `"first"` or
 * `"update"` (the wording, settled at boot) while the notice is due and `"1"` once acknowledged, so any
 * value but `"1"` reads as pending.
 */
export function warningStatus(
  loaded: boolean,
  failedKeys: ReadonlySet<string>,
  values: Readonly<Record<string, string | undefined>>,
): WarningStatus {
  if (!loaded) return "unread";
  if (failedKeys.has(ACK_KEY)) return "unreadable";
  return values[ACK_KEY] === "1" ? "acknowledged" : "pending";
}

/** `update` when any key of earlier Player use is stored, else `first`. */
export function warningKind(values: Readonly<Record<string, string | undefined>>): WarningKind {
  return PRIOR_USE_KEYS.some((key) => values[key] != null) ? "update" : "first";
}

export const useWarningStatus = (): WarningStatus =>
  usePreferencesStore((s) => warningStatus(s.loaded, s.failedKeys, s.values));

/** Whether visualizers may draw: true only once the warning is acknowledged. */
export const useVisualizersAllowed = (): boolean => useWarningStatus() === "acknowledged";

const storedKind = (values: Readonly<Record<string, string | undefined>>): WarningKind | null => {
  const value = values[ACK_KEY];
  return value === "first" || value === "update" ? value : null;
};

// Set once the user acknowledges in this session: nothing may write the flag's kind over the "1" after that.
let acknowledgedHere = false;

/** Test hook: forgets an acknowledgement made in this session. */
export const resetAcknowledgedHere = (): void => {
  acknowledgedHere = false;
};

/** The wording decided at boot while the flag could not be read or written; this session only. */
export const useSessionKind = create<{ kind: WarningKind | null }>(() => ({ kind: null }));

/**
 * Decides the notice's wording once, from what is stored before this session writes anything, and keeps it
 * in the flag. Call it after the first preferences load; it is safe from any window and a second call
 * changes nothing. An acknowledged flag or a stored kind is left alone. A flag that could not be read
 * writes nothing: the kind holds for the session and is written by the call that follows a successful retry.
 */
export function settleWarningKind(): void {
  const s = prefs();
  if (!s.loaded || acknowledgedHere) return;
  const stored = s.values[ACK_KEY];
  if (stored === "1") return;
  const known = storedKind(s.values);
  if (known) {
    useSessionKind.setState({ kind: known });
    return;
  }
  const kind = useSessionKind.getState().kind ?? warningKind(s.values);
  useSessionKind.setState({ kind });
  if (!s.failedKeys.has(ACK_KEY)) s.setPreference(ACK_KEY, kind);
}

/** The settled wording: the stored kind, else this session's, else the prior-use test on the live values. */
export const useWarningKind = (): WarningKind => {
  const stored = usePreferencesStore((s) => storedKind(s.values));
  const session = useSessionKind((s) => s.kind);
  const live = usePreferencesStore((s) => warningKind(s.values));
  return stored ?? session ?? live;
};

// ---- Choice snapshots ----

interface Snapshots {
  groups: readonly string[] | null;
  reactivity: Reactivity | null;
  kind: VisualizerKind | null;
}

const NO_SNAPSHOTS: Snapshots = { groups: null, reactivity: null, kind: null };

/** The values each choice replaced; null where the choice was never switched on in this session. */
export const useWarningSnapshots = create<Snapshots>(() => NO_SNAPSHOTS);

// ---- Pure next values ----

/** The catalog state after "Keep only Cozy" is switched on, or null when the write is refused. */
export function cozyOnlyOn(catalog: Catalog): CatalogState | null {
  return keepOnlyGroup(catalog, COZY);
}

/**
 * Whether the "Keep only Cozy" switch would refuse a press: the catalog is not writable, or turning it on
 * would offer no kind (every Cozy kind is off). A switch that is already on can always be switched off.
 */
export function cozyOnlyRefused(catalog: Catalog): boolean {
  if (!catalog.writable) return true;
  return !isCozyOnly(catalog) && cozyOnlyOn(catalog) == null;
}

/**
 * The catalog state after "Keep only Cozy" is switched off. With the snapshot, its families exactly;
 * without it, every known family on. Kinds are never changed. Null when the catalog is not writable.
 */
export function cozyOnlyOff(
  catalog: Catalog,
  snapshot: readonly string[] | null,
): CatalogState | null {
  if (!catalog.writable) return null;
  if (snapshot) return { kinds: catalog.state.kinds, groups: snapshot };
  return allGroupsOn(catalog);
}

/** The reactivity after "Calm" is switched on. */
export const calmOn = (): Reactivity => "calm";

/** The reactivity after "Calm" is switched off: the snapshot, else the default. */
export const calmOff = (snapshot: Reactivity | null): Reactivity => snapshot ?? DEFAULT_REACTIVITY;

/** The kind after "Turn visualizers off" is switched on. */
export const visualizersOffOn = (): VisualizerKind => "off";

/** The kind after "Turn visualizers off" is switched off: the snapshot, else the default. */
export const visualizersOffOff = (snapshot: VisualizerKind | null): VisualizerKind => snapshot ?? DEFAULT_VISUALIZER;

// ---- Switch state, derived from the live preferences ----

export const isCozyOnly = (catalog: Catalog): boolean => isOnlyGroup(catalog, COZY);
export const isCalm = (level: Reactivity): boolean => level === "calm";
export const isVisualizersOff = (kind: VisualizerKind): boolean => kind === "off";

// ---- Actions ----

type PrefsState = ReturnType<typeof usePreferencesStore.getState>;

const prefs = (): PrefsState => usePreferencesStore.getState();
const catalogNow = () => {
  const s = prefs();
  return catalogOf(s.values[PREF_KEYS.playerVisualizerCatalog], selectCatalogUnreadable(s));
};
const readable = (key: string): boolean => {
  const s = prefs();
  return s.loaded && !s.failedKeys.has(key);
};

/** Switches "Keep only Cozy". A refused write (unreadable or not writable catalog) changes nothing. */
export function setCozyOnly(on: boolean): void {
  const catalog = catalogNow();
  const snapshot = useWarningSnapshots.getState().groups;
  const next = on ? (isCozyOnly(catalog) ? null : cozyOnlyOn(catalog)) : cozyOnlyOff(catalog, snapshot);
  if (!next) return;
  useWarningSnapshots.setState({ groups: on ? catalog.state.groups : null });
  persistVisualizerCatalog(next);
}

/** Switches Reactivity "Calm". Refused while the reactivity key is unreadable. */
export function setCalm(on: boolean): void {
  if (!readable(PREF_KEYS.playerVisualizerReactivity)) return;
  const current = normalizeReactivity(prefs().values[PREF_KEYS.playerVisualizerReactivity]);
  const snapshot = useWarningSnapshots.getState().reactivity;
  if (on) {
    if (!isCalm(current)) useWarningSnapshots.setState({ reactivity: current });
  } else {
    useWarningSnapshots.setState({ reactivity: null });
  }
  prefs().setPreference(PREF_KEYS.playerVisualizerReactivity, on ? calmOn() : calmOff(snapshot));
}

/** Switches "Turn visualizers off". Refused while the pick key is unreadable. */
export function setVisualizersOff(on: boolean): void {
  if (!readable(PREF_KEYS.playerVisualizer)) return;
  const current = normalizeVisualizerKind(prefs().values[PREF_KEYS.playerVisualizer]);
  const snapshot = useWarningSnapshots.getState().kind;
  if (on) {
    if (!isVisualizersOff(current)) useWarningSnapshots.setState({ kind: current });
  } else {
    useWarningSnapshots.setState({ kind: null });
  }
  // Off outranks every default, and a temporary override would still draw over it.
  if (on) useVisualizerDefaults.getState().clearOverride();
  prefs().setPreference(PREF_KEYS.playerVisualizer, on ? visualizersOffOn() : visualizersOffOff(snapshot));
}

/**
 * Records the acknowledgement and drops the snapshots. The key leaves `failedKeys` first, so a late
 * re-read that finds nothing cannot delete the in-memory flag and lock the gate again.
 */
export function acknowledgeWarning(): void {
  usePreferencesStore.setState((s) => {
    if (!s.failedKeys.has(ACK_KEY)) return s;
    const failedKeys = new Set(s.failedKeys);
    failedKeys.delete(ACK_KEY);
    return { failedKeys };
  });
  prefs().setPreference(ACK_KEY, "1");
  acknowledgedHere = true;
  useWarningSnapshots.setState(NO_SNAPSHOTS);
}

export const useAcknowledgeWarning = (): (() => void) => acknowledgeWarning;
