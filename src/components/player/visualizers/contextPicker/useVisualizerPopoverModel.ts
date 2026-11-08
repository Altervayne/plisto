// -- Framework Imports --
import { useCallback, useMemo } from "react";

// -- Library Imports --
import { useShallow } from "zustand/react/shallow";

// -- State Imports --
import { useAlbum, useAlbumIndex } from "../../../../state/organize/store";
import { useTrack } from "../../../../state/store";
import { useVisualizerDefaults, useVisualizerDefaultsStatus } from "../../../../state/player/visualizerDefaults";
import { placeOf, storedDefaultsOf } from "../../../../state/player/visualizerResolve";

// -- Utils Imports --
import { resolveTrackAlbum } from "../../../tracks/trackAlbum";
import { visualizerPopoverModel } from "./visualizerPopoverModel";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { VisualizerKind } from "../../../../state/player/visualizerKind";
import type { PopoverModel, PopoverStored, PopoverSubject } from "./visualizerPopoverModel";

/** The album or track a context menu opens the popover for. */
export type VisualizerScope = { album: number } | { track: number };

export interface VisualizerPopoverState {
  model: PopoverModel;
  title: string;
  // The header's second line; null when a loose track names no album.
  subtitle: string | null;
  // False until the stored defaults are read; a write before then would be lost under the read.
  ready: boolean;
  // Writes the kind to the target tier, or clears it for null, then closes the popover and its menu.
  pick: (kind: VisualizerKind | null) => void;
}

export function useVisualizerPopoverModel(scope: VisualizerScope, close: () => void): VisualizerPopoverState {
  const t = useT();
  const albumIndex = useAlbumIndex();
  const isAlbum = "album" in scope;
  const albumId = "album" in scope ? scope.album : -1;
  const trackId = "track" in scope ? scope.track : -1;
  const album = useAlbum(albumId);
  const track = useTrack(trackId);
  const ready = useVisualizerDefaultsStatus() === "ready";

  // Keyed on the ids, not the scope object, which a menu may rebuild on every render.
  const subject = useMemo<PopoverSubject>(
    () => (isAlbum ? { kind: "album", albumId } : { kind: "track", place: placeOf(trackId, albumIndex) }),
    [isAlbum, albumId, trackId, albumIndex],
  );
  const stored = useVisualizerDefaults(
    useShallow(
      (s): PopoverStored =>
        subject.kind === "album"
          ? { trackDefault: null, albumDefault: s.albums[subject.albumId] ?? null }
          : storedDefaultsOf(subject.place, s.albums, s.tracks),
    ),
  );
  const model = useMemo(() => visualizerPopoverModel(subject, stored), [subject, stored]);

  let title: string;
  let subtitle: string | null;
  if (subject.kind === "album") {
    title = album?.title ?? t((d) => d.albums.untitled);
    subtitle = t((d) => d.player.visualizerAlbumBy, {
      artist: album?.album_artist ?? t((d) => d.albums.unknownArtist),
    });
  } else {
    title = track ? track.title_edit ?? track.raw_title ?? track.filename : t((d) => d.player.unknownTrack);
    const albumName = track ? resolveTrackAlbum(track, albumIndex) : null;
    subtitle = model.single
      ? t((d) => d.player.visualizerSingle)
      : albumName
        ? t((d) => d.player.visualizerTrackIn, { album: albumName })
        : null;
  }

  const { target } = model;
  const pick = useCallback(
    (kind: VisualizerKind | null) => {
      if (!target || !ready) return;
      const { setAlbumDefault, setTrackDefault } = useVisualizerDefaults.getState();
      void (target.tier === "album" ? setAlbumDefault(target.id, kind) : setTrackDefault(target.id, kind));
      close();
    },
    [target, ready, close],
  );

  return { model, title, subtitle, ready, pick };
}
