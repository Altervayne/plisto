/*
 * The visualizer a track resolves to: a temporary override, then the track default, then the album
 * default, then the global pick. Pure, so the stage, the pickers and their tests share one rule set.
 *
 * Every track keys its override to an album key. A filed track and a single key on their album, a loose
 * track on itself, so a pick never sticks across unrelated loose tracks. A file opened from disk has no
 * key and no defaults. A single has one tier: its album, so a stray track row on it is never read.
 * A stored string that names no kind means no default at that tier, never Ridge.
 */

// -- State Imports --
import { isVisualizerKind } from "./visualizerRegistry";

// -- Type Imports --
import type { VisualizerKind } from "./visualizerKind";
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
}

export interface Resolution {
  picked: VisualizerKind;
  source: VisualizerSource;
  // The default in play, still reported while an override sets it aside.
  defaultKind: VisualizerKind | null;
  defaultTier: DefaultTier | null;
}

/** What a manual pick writes: the override, and the global pref when no default is in play. */
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

function knownKind(raw: string | null): VisualizerKind | null {
  return isVisualizerKind(raw) ? raw : null;
}

// An override holds only while playback stays on the album key it was picked on.
function liveOverride(override: VisualizerOverride | null, albumKey: string | null): VisualizerKind | null {
  return override && albumKey != null && override.albumKey === albumKey ? override.kind : null;
}

export function resolveVisualizer(input: ResolveInput): Resolution {
  const track = knownKind(input.trackDefault);
  const album = knownKind(input.albumDefault);
  const defaultKind = track ?? album;
  const defaultTier: DefaultTier | null = track ? "track" : album ? "album" : null;
  const override = liveOverride(input.override, input.albumKey);
  // Clearing the last default during an override keeps the pick showing, with nothing left to set aside.
  const source: VisualizerSource = override && defaultKind ? "override" : defaultTier ?? "global";
  return { picked: override ?? defaultKind ?? input.global, source, defaultKind, defaultTier };
}

/**
 * A pick from the picker or V. Over a default it is a temporary override, and picking the default
 * itself drops it. With no default it writes the global pref and drops any override left behind.
 */
export function applyManualPick(input: ResolveInput, kind: VisualizerKind): ManualPick {
  const { defaultKind } = resolveVisualizer(input);
  if (defaultKind == null || input.albumKey == null) return { override: null, global: kind };
  return { override: kind === defaultKind ? null : { kind, albumKey: input.albumKey }, global: null };
}

/** The tier Clear default removes: the track tier first. A temporary pick stays. */
export function clearDefaultTier(input: Pick<ResolveInput, "trackDefault" | "albumDefault">): DefaultTier | null {
  if (knownKind(input.trackDefault)) return "track";
  if (knownKind(input.albumDefault)) return "album";
  return null;
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
    clear: { visible: res.defaultTier != null, disabled: off },
  };
}
