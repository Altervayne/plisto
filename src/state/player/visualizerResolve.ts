/*
 * The visualizer a track resolves to: a temporary override, then the track default, then the album
 * default, then the global pick. The global pick Off outranks all of them; nothing stored is rewritten.
 * Pure, so the stage, the pickers and their tests share one rule set.
 *
 * Every track keys its override to an album key. A filed track and a single key on their album, a loose
 * track on itself, so a pick never sticks across unrelated loose tracks. A file opened from disk has no
 * key and no defaults. A single has one tier: its album, so a stray track row on it is never read.
 * A stored string that names no kind means no default at that tier, never Ridge.
 *
 * A former plugin kind id reads as its current one; only the next write of that value stores the new id.
 * A plugin kind read before the plugins list has arrived is pending: it is taken at its word, never read
 * as gone, so no fallback stands in for it.
 */

// -- State Imports --
import {
  isPendingPluginKind,
  isPluginKindId,
  pluginFamilyOf,
  pluginVisualizer,
  resolveAlias,
} from "./pluginVisualizers";
import { isOffered, type Catalog } from "./visualizerCatalog";
import { isKnownKind, type VisualizerKind } from "./visualizerKind";

// -- Type Imports --
import type { AlbumKind } from "../../types";

export type DefaultTier = "album" | "track";

export type VisualizerSource = "global" | DefaultTier | "override";

/** Where a track sits for defaults: in an album or a single, loose in the library, or outside it. */
export type TrackPlace =
  | { kind: "adhoc" }
  | { kind: "loose"; trackId: number }
  | { kind: "album" | "single"; trackId: number; albumId: number };

/** A manual pick that sets a default aside until playback reaches another album key. */
export interface VisualizerOverride {
  kind: VisualizerKind;
  albumKey: string;
}

export interface ResolveInput {
  global: VisualizerKind;
  // The raw stored strings, as read from the defaults store.
  trackDefault: string | null;
  albumDefault: string | null;
  override: VisualizerOverride | null;
  albumKey: string | null;
  // Which kinds are offered. A tier naming a kind it turns off is skipped; nothing stored is rewritten.
  catalog: Catalog;
  // True until the plugins list has been read once, so a stored plugin kind is pending.
  pluginsPending?: boolean;
}

/** A stored default the catalog turns off, so it is not in play. */
export interface SkippedDefault {
  kind: VisualizerKind;
  tier: DefaultTier;
}

export interface Resolution {
  picked: VisualizerKind;
  source: VisualizerSource;
  // The default in play, still reported while an override or the global pick Off sets it aside.
  defaultKind: VisualizerKind | null;
  defaultTier: DefaultTier | null;
  // The turned-off default that outranks the one in play, or the highest one when none is in play.
  skipped: SkippedDefault | null;
}

/** What a manual pick writes: the override, and the global pref when no default is in play or Off is involved. */
export interface ManualPick {
  override: VisualizerOverride | null;
  // Null leaves the global pref as it is.
  global: VisualizerKind | null;
}

export interface DefaultAction {
  visible: boolean;
  disabled: boolean;
}

export interface DefaultActions {
  useAlbum: DefaultAction;
  useTrack: DefaultAction;
  clear: DefaultAction;
}

export type DefaultsStatus = "loading" | "ready" | "failed";

/** A track's album row, as the track-to-album index holds it. */
type AlbumOfTrack = { id: number; kind: AlbumKind };

/** Where a track sits. Negative ids are files opened from disk, outside the library. */
export function placeOf(trackId: number, albumIndex: ReadonlyMap<number, AlbumOfTrack>): TrackPlace {
  if (trackId < 0) return { kind: "adhoc" };
  const album = albumIndex.get(trackId);
  if (!album) return { kind: "loose", trackId };
  return { kind: album.kind, trackId, albumId: album.id };
}

/** The key a manual pick holds on, or null for a track outside the library. */
export function albumKeyOf(trackId: number, albumIndex: ReadonlyMap<number, AlbumOfTrack>): string | null {
  return keyOfPlace(placeOf(trackId, albumIndex));
}

export function keyOfPlace(place: TrackPlace): string | null {
  if (place.kind === "adhoc") return null;
  if (place.kind === "loose") return `track:${place.trackId}`;
  return `album:${place.albumId}`;
}

/** The stored strings that apply to a place, with the tiers it cannot hold left out. */
export function storedDefaultsOf(
  place: TrackPlace,
  albums: Readonly<Record<number, string>>,
  tracks: Readonly<Record<number, string>>,
): { trackDefault: string | null; albumDefault: string | null } {
  switch (place.kind) {
    case "adhoc":
      return { trackDefault: null, albumDefault: null };
    case "loose":
      return { trackDefault: tracks[place.trackId] ?? null, albumDefault: null };
    case "single":
      return { trackDefault: null, albumDefault: albums[place.albumId] ?? null };
    case "album":
      return { trackDefault: tracks[place.trackId] ?? null, albumDefault: albums[place.albumId] ?? null };
  }
}

// A stored string as a kind: a known kind under its current id, or a pending plugin kind. Null otherwise.
function readKind(raw: string | null, input: ResolveInput): VisualizerKind | null {
  if (raw == null) return null;
  const id = resolveAlias(raw);
  if (isKnownKind(id)) return id;
  return isPluginKindId(id) && isPendingPluginKind(id, !input.pluginsPending) ? id : null;
}

// A pending plugin kind has no catalog entry yet: it is offered unless the stored catalog turns it or its
// family off.
function offered(catalog: Catalog, kind: VisualizerKind): boolean {
  if (!isPluginKindId(kind) || pluginVisualizer(kind)) return isOffered(catalog, kind);
  const family = pluginFamilyOf(kind.slice(0, kind.indexOf("/")));
  return !catalog.state.kinds.includes(kind) && !catalog.state.groups.includes(family);
}

// A stored default in play: a kind read from it that the catalog offers.
function offeredKindOf(raw: string | null, input: ResolveInput): VisualizerKind | null {
  const kind = readKind(raw, input);
  return kind && offered(input.catalog, kind) ? kind : null;
}

// An override holds only while playback stays on the album key it was picked on, and only on an offered kind.
function liveOverride(input: ResolveInput): VisualizerKind | null {
  const { override, albumKey } = input;
  if (!override || albumKey == null || override.albumKey !== albumKey) return null;
  return offeredKindOf(override.kind, input);
}

// The global pick when it is offered, else the catalog's fallback. Off is always offered.
function globalKind(input: ResolveInput): VisualizerKind {
  return offeredKindOf(input.global, input) ?? (input.catalog.fallback as VisualizerKind);
}

// The known default a turned-off kind keeps out of play, when it outranks the one in play.
function skippedDefault(input: ResolveInput, played: DefaultTier | null): SkippedDefault | null {
  const track = readKind(input.trackDefault, input);
  if (track && played !== "track") return { kind: track, tier: "track" };
  const album = readKind(input.albumDefault, input);
  if (album && played == null) return { kind: album, tier: "album" };
  return null;
}

export function resolveVisualizer(input: ResolveInput): Resolution {
  const track = offeredKindOf(input.trackDefault, input);
  const album = offeredKindOf(input.albumDefault, input);
  const defaultKind = track ?? album;
  const defaultTier: DefaultTier | null = track ? "track" : album ? "album" : null;
  const override = liveOverride(input);
  const picked = override ?? defaultKind ?? globalKind(input);
  const skipped = skippedDefault(input, defaultTier);
  // The global pick Off outranks every default and override. The default stays reported, so the pickers
  // can name it while it waits.
  if (input.global === "off" && picked !== "off") {
    return { picked: "off", source: "global", defaultKind, defaultTier, skipped };
  }
  // Clearing the last default during an override keeps the pick showing, with nothing left to set aside.
  const source: VisualizerSource = override && defaultKind ? "override" : defaultTier ?? "global";
  return { picked, source, defaultKind, defaultTier, skipped };
}

/** Whether the global pick Off keeps the default in play from drawing. */
export function defaultWaits(res: Resolution): boolean {
  return res.source === "global" && res.defaultKind != null && res.defaultKind !== res.picked;
}

/**
 * A pick from the picker or V. Off always writes the global pref and drops the override. A kind picked
 * while the global pref is Off becomes the global pref. Over a default a kind is a temporary override,
 * and picking the default itself drops it. With no default it writes the global pref and drops any
 * override left behind. A former plugin kind id is written as its current one.
 */
export function applyManualPick(input: ResolveInput, picked: VisualizerKind): ManualPick {
  const kind = resolveAlias(picked);
  if (kind === "off") return { override: null, global: "off" };
  const { defaultKind } = resolveVisualizer(input);
  if (defaultKind == null || input.albumKey == null) return { override: null, global: kind };
  const override = kind === defaultKind ? null : { kind, albumKey: input.albumKey };
  return { override, global: input.global === "off" ? kind : null };
}

/**
 * The tier Clear default removes: the one the aside names, a turned-off default before the one in play,
 * the track tier before the album. A temporary pick stays.
 */
export function clearDefaultTier(res: Pick<Resolution, "skipped" | "defaultTier">): DefaultTier | null {
  return res.skipped?.tier ?? res.defaultTier;
}

/**
 * Whether writing a kind ends the override, so the written default shows. Only a write that lands on
 * what is playing does: the overridden album, or the playing track.
 */
export function writeEndsOverride(
  override: VisualizerOverride | null,
  target: { album: number } | { track: number },
  playingTrackId: number | null,
): boolean {
  if (!override) return false;
  if ("album" in target) return override.albumKey === `album:${target.album}`;
  return playingTrackId != null && target.track === playingTrackId;
}

/**
 * The picker's three default actions for the playing track. A single offers only the album tier, a
 * loose track only the track tier, a file from disk none. Until the stored defaults are read, every
 * action is disabled.
 */
export function defaultActions(place: TrackPlace, res: Resolution, status: DefaultsStatus): DefaultActions {
  const off = status !== "ready";
  const overridden = res.source === "override";
  const albumTier = res.defaultTier === "album" ? res.defaultKind : null;
  const trackTier = res.defaultTier === "track" ? res.defaultKind : null;
  return {
    useAlbum: {
      visible: place.kind === "album" || place.kind === "single",
      disabled: off || (albumTier === res.picked && !overridden),
    },
    useTrack: {
      visible: place.kind === "album" || place.kind === "loose",
      disabled: off || (trackTier === res.picked && !overridden),
    },
    // A skipped default stays removable.
    clear: { visible: res.defaultTier != null || res.skipped != null, disabled: off },
  };
}
