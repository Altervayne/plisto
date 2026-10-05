// -- Icon Imports --
import { Tag, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";

// -- Hook Imports --
import { useAlbumCover } from "../albums/useAlbumCover";
import { usePlaylistCover } from "../playlists/usePlaylistCover";
import { useTrackThumb } from "../covers/useTrackThumb";

// -- Utils Imports --
import { DESTINATION_ICON } from "./finderDestinations";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";

// -- Style Imports --
import styles from "./FinderThumb.module.css";

function AlbumThumb({ albumId }: { albumId: number }) {
  const { src } = useAlbumCover(albumId, "thumb");
  return <Cover src={src} />;
}

function PlaylistThumb({ playlistId }: { playlistId: number }) {
  const { src } = usePlaylistCover(playlistId, "thumb");
  return <Cover src={src} />;
}

function TrackThumb({ trackId }: { trackId: number }) {
  return <Cover src={useTrackThumb(trackId)} />;
}

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={styles.glyph}>
      <Icon size={16} strokeWidth={1.8} />
    </span>
  );
}

function lead(entry: FinderEntry) {
  switch (entry.kind) {
    case "album":
    case "single":
      return <AlbumThumb albumId={entry.id} />;
    case "playlist":
      return <PlaylistThumb playlistId={entry.id} />;
    case "track":
      return <TrackThumb trackId={entry.id} />;
    case "artist":
      return <Glyph icon={UserRound} />;
    case "genre":
      return <Glyph icon={Tag} />;
    case "destination":
      return <Glyph icon={DESTINATION_ICON[entry.id]} />;
  }
}

/** A finder row's lead: the cover for anything that has art, a quiet glyph for the rest. */
export function FinderThumb({ entry }: { entry: FinderEntry }) {
  return (
    <span className={styles.thumb} aria-hidden="true">
      {lead(entry)}
    </span>
  );
}
