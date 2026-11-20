// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { useShallow } from "zustand/react/shallow";

// -- State Imports --
import { openStampSheet, useFileWritesRunning } from "../../state/fileWrites/store";
import { useStampFiles } from "../../state/preferences/store";
import { useAlbum, useAlbumTracks, useGenres } from "../../state/organize/store";
import { useAppStore } from "../../state/store";

// -- Utils Imports --
import { stampDifferCount } from "../../lib/ipc";
import { albumsStampScope } from "../../lib/stampScope";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./StampDoorLine.module.css";

/**
 * The album header's door into the tag-write sheet: how many of the album's files differ from what
 * Plisto shows, with a link that opens the sheet on the album. Absent while the feature is off, while
 * nothing differs, and when the count cannot be read. The count is read once per album, again when a
 * write batch ends or the library reloads.
 */
export function StampDoorLine({ albumId }: { albumId: number }) {
  const enabled = useStampFiles();
  const members = useAlbumTracks(albumId);
  const total = members.length;
  const ids = members.map((m) => m.track_id);
  // Row identity is the signal: a row is replaced only on an edit, a genre change or a scan
  // merge. The album record and genre list carry the resolved values.
  const rows = useAppStore(
    useShallow((s) => {
      const byId = new Map(s.tracks.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id));
    }),
  );
  const album = useAlbum(albumId);
  const genres = useGenres();
  const running = useFileWritesRunning();
  const t = useT();
  const [differing, setDiffering] = useState(0);

  // A different album starts from zero; a re-read of the same one keeps its count until the new one lands.
  useEffect(() => setDiffering(0), [albumId]);

  // `running` is null between batches, so the read refreshes as one ends.
  const idle = running == null;
  useEffect(() => {
    if (!enabled || !idle) return;
    let live = true;
    stampDifferCount(albumsStampScope([albumId]))
      .then((r) => live && setDiffering(r.files))
      .catch(() => live && setDiffering(0));
    return () => {
      live = false;
    };
  }, [enabled, idle, albumId, rows, album, genres]);

  if (!enabled || differing <= 0) return null;

  return (
    <span className={styles.line}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>{t((d) => d.fileWrites.entry.doorLine, { n: total, differing })}</span>
      <button
        type="button"
        className={styles.link}
        onClick={() => openStampSheet(albumsStampScope([albumId]))}
      >
        {t((d) => d.fileWrites.entry.doorAction)}
      </button>
    </span>
  );
}
