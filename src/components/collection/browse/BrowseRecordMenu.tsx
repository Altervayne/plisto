// -- Framework Imports --
import { useState } from "react";
import type { ReactNode } from "react";

// -- Icon Imports --
import { ArrowRight, Check, ListEnd, ListPlus, ListStart, Play } from "lucide-react";

// -- Component Imports --
import { ContextMenu } from "../../common/ContextMenu";
import { PlaylistPicker } from "../../playlists/PlaylistPicker";

// -- State Imports --
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  usePlaylists,
} from "../../../state/playlists/store";

// -- Utils Imports --
import { browseMenuSlots } from "./browseMenu";

// -- Type Imports --
import type { MenuEntry } from "../../common/ContextMenu";
import type { BrowseMenuId } from "./browseMenu";
import type { RecordActions } from "./useRecordActions";
import type { AlbumRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

const icon = (Glyph: typeof Play): ReactNode => <Glyph size={16} strokeWidth={1.8} />;

/**
 * The focused record's context menu, opened at a viewport point, plus the playlist picker its Add to
 * playlist opens. The picker outlives the menu, so it holds the record's tracks while it is up.
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
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const [picking, setPicking] = useState<number[] | null>(null);

  const entry = (id: BrowseMenuId): MenuEntry => {
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
          label: t((d) => d.playlists.addTo),
          onSelect: () => setPicking(actions.tracks.map((track) => track.track_id)),
        };
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

  const items = browseMenuSlots({ player, organize }).map((slot) =>
    slot === null ? { separator: true as const } : entry(slot),
  );

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
            void addTracksToPlaylist(playlistId, picking);
            setPicking(null);
          }}
          onCreate={(name) => {
            const targets = picking;
            void (async () => {
              const playlistId = await createPlaylist(name);
              await addTracksToPlaylist(playlistId, targets);
            })();
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
