// -- Icon Imports --
import { ArrowRight, Check, Play } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";

// -- State Imports --
import { useGenres } from "../../../state/organize/store";

// -- Utils Imports --
import { groupByDisc } from "../../albums/albumLayout";
import { genreFiling } from "./genreFiling";

// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { AlbumRow, AlbumTrackRow, GenreRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./BrowseInfo.module.css";

/** "N tracks - D discs - year - M min", each part dropped when the record does not carry it. */
function metaLine(album: AlbumRow, tracks: AlbumTrackRow[], t: Translate): string {
  const parts = [
    album.kind === "single"
      ? t((d) => d.singles.marker)
      : t((d) => d.albums.trackCount, { n: album.track_count }),
  ];
  const discs = groupByDisc(tracks).length;
  if (discs > 1) parts.push(t((d) => d.collection.browseDiscs, { n: discs }));
  if (album.year != null) parts.push(String(album.year));
  const timed = tracks.filter((track) => track.duration_secs != null);
  if (timed.length > 0) {
    const seconds = timed.reduce((sum, track) => sum + (track.duration_secs ?? 0), 0);
    parts.push(t((d) => d.collection.browseMinutes, { n: Math.round(seconds / 60) }));
  }
  return parts.join(" - ");
}

/** The genre-filing sentence, or null when no track carries a genre. */
function filingLine(tracks: AlbumTrackRow[], genres: GenreRow[], t: Translate): string | null {
  const filing = genreFiling(tracks, genres);
  if (!filing) return null;
  const head = t((d) => d.collection.browseFiled, {
    n: filing.total,
    genre: filing.genre,
    count: filing.count,
  });
  const tie =
    filing.tied.length > 0
      ? t((d) => d.collection.browseFiledTie, { names: filing.tied.join(", ") })
      : "";
  const also =
    filing.others.length > 0
      ? ` ${t((d) => d.collection.browseFiledAlso, {
          list: filing.others.map((o) => `${o.name} ${o.count}`).join(", "),
        })}`
      : "";
  return `${head}${tie}.${also}`;
}

/**
 * The focused record's text and actions, as plain typography under the shelf: title, artist, the
 * meta line, the genre-filing line under Genre grouping, then the play disc (the one accent on
 * screen, gone while the player is off), the hand-off to its wall, and Select while organizing is on.
 */
export function BrowseInfo({
  album,
  tracks,
  filed,
  player,
  organize,
  onPlay,
  onOpen,
  onSelect,
}: {
  album: AlbumRow;
  tracks: AlbumTrackRow[];
  /** Grouped by genre: say why the record files where it does. */
  filed: boolean;
  player: boolean;
  organize: boolean;
  onPlay: () => void;
  onOpen: () => void;
  onSelect: () => void;
}) {
  const t = useT();
  const genres = useGenres();
  const title = album.title ?? t((d) => d.albums.untitled);
  const filing = filed ? filingLine(tracks, genres, t) : null;

  return (
    <div className={styles.info}>
      <div className={styles.text}>
        <div className={styles.title}>{title}</div>
        {album.album_artist ? <div className={styles.artist}>{album.album_artist}</div> : null}
        <div className={styles.meta}>{metaLine(album, tracks, t)}</div>
        {filing ? <div className={styles.filing}>{filing}</div> : null}
      </div>
      <div className={styles.actions}>
        {player ? (
          <button
            type="button"
            className={styles.play}
            aria-label={t((d) => d.collection.browsePlay, { title })}
            onClick={onPlay}
          >
            <Play size={18} strokeWidth={2} fill="currentColor" />
          </button>
        ) : null}
        <QuietButton onClick={onOpen}>
          <ArrowRight size={15} strokeWidth={2} />
          {album.kind === "single"
            ? t((d) => d.collection.browseOpenSingles)
            : t((d) => d.collection.browseOpenAlbums)}
        </QuietButton>
        {organize ? (
          <QuietButton onClick={onSelect}>
            <Check size={15} strokeWidth={2} />
            {t((d) => d.common.select)}
          </QuietButton>
        ) : null}
      </div>
    </div>
  );
}
