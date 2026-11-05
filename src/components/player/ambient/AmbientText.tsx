// -- Hook Imports --
import { useTrackDisplay } from "../useTrackDisplay";

// -- State Imports --
import { usePlayingFrom } from "../../../state/player/store";
import { useAlbum } from "../../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./AmbientStage.module.css";

/**
 * The words beside the cover in ambient mode: the source kind over the title and artist, and the album
 * with its year beneath. The source and album lines fade with the chrome; the title and artist stay.
 */
export function AmbientText({ trackId, faded }: { trackId: number; faded: boolean }) {
  const { title, artist } = useTrackDisplay(trackId);
  const source = usePlayingFrom();
  const album = useAlbum(source?.kind === "album" ? source.id : -1);
  const t = useT();

  let kind: string | null = null;
  let line: string | null = null;
  if (source?.kind === "album") {
    kind = `${t((d) => d.player.playingFrom)} ${t((d) => d.player.sourceAlbum)}`;
    line = album?.year != null ? `${source.label} \u00b7 ${album.year}` : source.label;
  } else if (source?.kind === "playlist") {
    kind = `${t((d) => d.player.playingFrom)} ${t((d) => d.player.sourcePlaylist)}`;
    line = source.label;
  }

  return (
    <div className={styles.text}>
      {kind ? (
        <span className={styles.sourceLabel} data-faded={faded ? "" : undefined}>
          {kind}
        </span>
      ) : null}
      <h1 className={styles.title}>{title ?? t((d) => d.albums.untitled)}</h1>
      <p className={styles.artist}>{artist ?? t((d) => d.albums.unknownArtist)}</p>
      {line ? (
        <span className={styles.albumLine} data-faded={faded ? "" : undefined}>
          {line}
        </span>
      ) : null}
    </div>
  );
}
