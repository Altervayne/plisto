// -- Framework Imports --
import { useState } from "react";
import type { ReactNode } from "react";

// -- Icon Imports --
import { ArrowRight, Check, ListEnd, ListPlus, ListStart, Play } from "lucide-react";

// -- Component Imports --
import { ContextMenu } from "../../common/ContextMenu";
import { PlaylistPicker } from "../../playlists/PlaylistPicker";

// -- State Imports --
import { useCreatePlaylist, usePlaylists } from "../../../state/playlists/store";

// -- Hook Imports --
import { usePlaylistAdd } from "../../playlists/usePlaylistAdd";
import { useWriteGate } from "../../organize/useWriteGate";

// -- Utils Imports --
import { browseMenuSlots } from "./browseMenu";
import { visualizerMenuItem } from "../../player/visualizers/contextPicker/visualizerMenuItem";

// -- Type Imports --
import type { MenuEntry } from "../../common/ContextMenu";
import type { PlaylistAdd } from "../../playlists/usePlaylistAdd";
import type { BrowseMenuId } from "./browseMenu";
import type { RecordActions } from "./useRecordActions";
import type { AlbumRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

const icon = (Glyph: typeof Play): ReactNode => <Glyph size={16} strokeWidth={1.8} />;

/**
 * The focused record's context menu, opened at a viewport point, plus the playlist picker its Add to
 * playlist opens. The picker outlives the menu, so it holds what to add while it is up: an album goes in
 * as one entry, a single as its track.
 */
export function BrowseRecordMenu({
  album,
  at,
  actions,
  player,
  organize,
  onClose,
}: {
  album: AlbumRow;
  /** Where the menu opens; null keeps it closed. */
  at: { x: number; y: number } | null;
  actions: RecordActions;
  player: boolean;
  organize: boolean;
  /** The menu closed, by a choice or a dismiss. */
  onClose: () => void;
}) {
  const t = useT();
  const playlists = usePlaylists();
  const addToPlaylist = usePlaylistAdd();
  const createPlaylist = useCreatePlaylist();
  const [picking, setPicking] = useState<PlaylistAdd | null>(null);
  const single = album.kind === "single";
  // An album goes in as an entry that expands against album membership; a single goes in as its track.
  const gate = useWriteGate(single ? "playlists" : "both");

  const entry = (id: BrowseMenuId): MenuEntry | null => {
    switch (id) {
      case "play":
        return { icon: icon(Play), label: t((d) => d.player.play), onSelect: actions.play };
      case "next":
        return { icon: icon(ListStart), label: t((d) => d.player.playNext), onSelect: actions.playNext };
      case "queue":
        return { icon: icon(ListEnd), label: t((d) => d.player.addToQueue), onSelect: actions.addToQueue };
      case "playlist":
        return {
          icon: icon(ListPlus),
          label: single ? t((d) => d.playlists.addTo) : t((d) => d.playlists.addAlbumTo),
          disabled: gate.blocked,
          tooltip: gate.tip,
          onSelect: () =>
            setPicking(
              single
                ? { kind: "tracks", trackIds: actions.tracks.map((track) => track.track_id) }
                : { kind: "albums", albumIds: [album.id] },
            ),
        };
      case "visualizer":
        return visualizerMenuItem({ album: album.id }, t);
      case "open":
        return {
          icon: icon(ArrowRight),
          label:
            album.kind === "single"
              ? t((d) => d.collection.browseOpenSingles)
              : t((d) => d.collection.browseOpenAlbums),
          onSelect: actions.open,
        };
      case "select":
        return { icon: icon(Check), label: t((d) => d.common.select), onSelect: actions.select };
    }
  };

  const items = browseMenuSlots({ player, organize }).flatMap((slot) => {
    const built = slot === null ? { separator: true as const } : entry(slot);
    return built ? [built] : [];
  });

  return (
    <>
      <ContextMenu
        open={at !== null}
        x={at?.x ?? 0}
        y={at?.y ?? 0}
        onClose={onClose}
        items={items}
        ariaLabel={album.title ?? t((d) => d.albums.untitled)}
      />
      {picking ? (
        <PlaylistPicker
          playlists={playlists}
          onChoose={(playlistId) => {
            void addToPlaylist(playlistId, picking);
            setPicking(null);
          }}
          onCreate={(name) => {
            const target = picking;
            void (async () => {
              const playlistId = await createPlaylist(name);
              await addToPlaylist(playlistId, target);
            })();
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
