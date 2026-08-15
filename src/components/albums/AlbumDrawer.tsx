// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { QuietButton } from "../common/QuietButton";
import { EditableField } from "../common/EditableField/EditableField";
import { AlbumCoverField } from "./AlbumCoverField";
import { AlbumMetaFields } from "./AlbumMetaFields";
import { AlbumTrackList } from "./AlbumTrackList";
import { SingleSourceRow } from "./SingleSourceRow";
import { AlbumDeleteControl } from "./AlbumDeleteControl";

// -- Icon Imports --
import { Maximize2 } from "lucide-react";

// -- State Imports --
import { useCommitAlbumFields } from "../../state/organize/store";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumDrawer.module.css";

/**
 * Returns true when focus is in a text field, so an Escape there is the field's to handle (a revert),
 * not the drawer's to close.
 */
function editingField(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

/**
 * The album edit drawer: the cover slot, the title hero, the metadata fields, and the track list, held
 * on the continuous ground by the edge veil like the read-only track peek. Fields auto-commit on blur
 * through the command engine. Escape closes the drawer, unless a field is focused - then it reverts the
 * field and the drawer stays open. A single reuses the same shell with its multi-track region traded for
 * one read-only source row, and its delete relabelled to "Remove single". An album drawer also offers
 * Open, which hands the album up to the full-pane view; a single has no such view.
 */
export function AlbumDrawer({
  album,
  onClose,
  onOpenFull,
}: {
  album: AlbumRow;
  onClose: () => void;
  onOpenFull?: (albumId: number) => void;
}) {
  const commit = useCommitAlbumFields();
  const t = useT();
  const single = album.kind === "single";
  const fields = {
    title: album.title,
    album_artist: album.album_artist,
    year: album.year,
    genre: album.genre,
  };

  useEffect(() => {
    // Capture phase: this runs before a focused field handles Escape and blurs, so activeElement still
    // reads as the field and the drawer yields the key to it rather than closing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editingField()) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <aside
      className={styles.drawer}
      aria-label={single ? t((d) => d.singles.details) : t((d) => d.albums.details)}
    >
      <ScrollArea className={styles.scroll} contentClassName={styles.inner}>
        <div className={styles.head}>
          <div className={styles.titleWrap}>
            <EditableField
              value={album.title ?? ""}
              ariaLabel={t((d) => d.albums.albumTitle)}
              placeholder={t((d) => d.albums.untitled)}
              big
              onCommit={(next) => commit(album.id, { ...fields, title: next === "" ? null : next })}
            />
          </div>
          {onOpenFull && !single ? (
            <QuietButton onClick={() => onOpenFull(album.id)} aria-label={t((d) => d.albums.open)}>
              <Maximize2 size={15} strokeWidth={1.8} />
              <span>{t((d) => d.albums.open)}</span>
            </QuietButton>
          ) : null}
          <QuietButton onClick={onClose} aria-label={t((d) => d.common.closeDetails)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        <AlbumCoverField albumId={album.id} />
        <AlbumMetaFields album={album} />

        <div className={styles.tracks}>
          {single ? (
            <>
              <p className={styles.section}>{t((d) => d.singles.source)}</p>
              <SingleSourceRow albumId={album.id} />
            </>
          ) : (
            <>
              <p className={styles.section}>{t((d) => d.albums.tracks)}</p>
              <AlbumTrackList albumId={album.id} />
            </>
          )}
        </div>

        <AlbumDeleteControl albumId={album.id} onDeleted={onClose} single={single} />
      </ScrollArea>
    </aside>
  );
}
