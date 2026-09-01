// -- Framework Imports --
import { useEffect } from "react";

// -- Icon Imports --
import { Crop, Scissors } from "lucide-react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { EditableField } from "../common/EditableField/EditableField";
import { TrackDetailCover } from "./TrackDetailCover";
import { TrackGenres } from "./TrackGenres";
import { KeepOwnCoverToggle } from "./KeepOwnCoverToggle";

// -- State Imports --
import { useEditTrack, useTrack } from "../../state/store";
import { useSetOpenTool } from "../../state/shell/store";

// -- Utils Imports --
import { canSplice } from "../../lib/splice";

// -- Utils Imports --
import { parseDisc, formatDisc } from "../albums/discField";
import { parseYear, formatYear } from "../albums/yearField";
import { formatBytes, formatDuration, formatTimestamp } from "../../lib/format";

// -- Type Imports --
import type { TrackEditFields, TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Translate } from "../../i18n";

// -- Style Imports --
import styles from "./TrackDetail.module.css";

/** One immutable file fact in the read-only zone. A mono value marks a raw path, shown verbatim. */
interface FileFact {
  label: string;
  value: string;
  mono?: boolean;
}

/** Renders a raw value for display, folding an absent one to a deliberate dash. */
function show(value: string | number | null): string {
  if (value == null || value === "") return "-";
  return String(value);
}

/** The filename without its extension: everything before the last dot, or the whole name when it has none. */
function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** The immutable file facts, in reading order: the container, then the paths Plisto never rewrites. */
function fileFactsOf(track: TrackRow, t: Translate): FileFact[] {
  return [
    { label: t((d) => d.tracks.fields.length), value: formatDuration(track.duration_secs) },
    { label: t((d) => d.tracks.fields.format), value: track.ext.toUpperCase() },
    { label: t((d) => d.tracks.fields.size), value: formatBytes(track.size_bytes) },
    { label: t((d) => d.tracks.fields.modified), value: formatTimestamp(track.mtime) },
    { label: t((d) => d.tracks.fields.indexed), value: formatTimestamp(track.scanned_at) },
    { label: t((d) => d.tracks.fields.filename), value: track.filename, mono: true },
    { label: t((d) => d.tracks.fields.sourcePath), value: track.source_path, mono: true },
  ];
}

/** The editable text tag keys; year and disc are numeric and take their own parsed handlers. */
type TextKey = "title" | "artist" | "album" | "album_artist";

/**
 * One editable tag: a label over an `EditableField`, with a quiet edited marker and revert that show
 * only when the field's edit is a real change from raw. The title face uses `big`; it carries no
 * label, standing as the peek's hero.
 */
function TagField({
  label,
  value,
  ariaLabel,
  placeholder,
  big = false,
  edited,
  onCommit,
  onRevert,
}: {
  label?: string;
  value: string;
  ariaLabel: string;
  placeholder?: string;
  big?: boolean;
  edited: boolean;
  onCommit: (next: string) => void;
  onRevert: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.tag}>
      {label ? <span className={styles.label}>{label}</span> : null}
      <EditableField
        value={value}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        big={big}
        onCommit={onCommit}
      />
      {edited ? (
        <div className={styles.editline}>
          <span className={styles.editedMark}>{t((d) => d.common.edited)}</span>
          <button type="button" className={styles.revert} onClick={onRevert}>
            {t((d) => d.common.revert)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Files-view detail peek: a calm reading surface that edits in place. The top zone is the track's
 * tags - title, artist, album, album artist, year, disc, and genres - each resolved as `edit ?? raw`
 * and committed through the track's own optimistic edit path. The lower zone is the immutable file
 * facts, deliberately inert: Plisto never rewrites the user's files. Dismiss with the close button or
 * Escape. Reads the live store row, not the select-time snapshot, so an edit shows at once.
 *
 * `albumFallback` is the album container's own album/album_artist/year, passed when the peek opens from
 * an album. The three fields then resolve `edit ?? container ?? raw`, so the preview matches what an
 * export writes (export takes the container, not the raw tag). The edited marker stays keyed on the
 * edit differing from its own raw, so the container never lights it. Absent, the fields resolve as
 * `edit ?? raw`, the Files behavior.
 *
 * `keepOwnCover` carries the membership's keep-own-cover flag and its setter, passed only when the peek
 * opens from an album - the flag is an album_tracks concern, so a loose or Files-view peek never shows
 * the toggle.
 */
export function TrackDetail({
  track,
  onClose,
  albumFallback,
  keepOwnCover,
}: {
  track: TrackRow;
  onClose: () => void;
  albumFallback?: { album: string | null; album_artist: string | null; year: number | null };
  keepOwnCover?: { value: boolean; onChange: (next: boolean) => void };
}) {
  const live = useTrack(track.id) ?? track;
  const editTrack = useEditTrack();
  const setOpenTool = useSetOpenTool();
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The track's current edit layer as a full set. Every commit sends this set with the one field it
  // changed, since the backend write is a full-set replace where a null clears that column to raw.
  const edits: TrackEditFields = {
    title: live.title_edit,
    artist: live.artist_edit,
    album: live.album_edit,
    album_artist: live.album_artist_edit,
    year: live.year_edit,
    disc_no: live.disc_edit,
  };

  // Committing empty or the exact raw value clears the field's edit back to raw; anything else stores
  // the typed value. EditableField hands over the trimmed text and fires only on a real change.
  const commitText = (key: TextKey, raw: string | null) => (next: string) => {
    const value = next === "" || next === (raw ?? "") ? null : next;
    void editTrack(live.id, { ...edits, [key]: value });
  };
  const revertText = (key: TextKey) => () => void editTrack(live.id, { ...edits, [key]: null });

  // Numeric fields parse to int-or-null (disc rejects below one); a parse that lands on raw reverts.
  const commitYear = (next: string) => {
    const parsed = parseYear(next);
    const value = parsed == null || parsed === live.raw_year ? null : parsed;
    void editTrack(live.id, { ...edits, year: value });
  };
  const commitDisc = (next: string) => {
    const parsed = parseDisc(next);
    const value = parsed == null || parsed === live.raw_disc_no ? null : parsed;
    void editTrack(live.id, { ...edits, disc_no: value });
  };
  const revertYear = () => void editTrack(live.id, { ...edits, year: null });
  const revertDisc = () => void editTrack(live.id, { ...edits, disc_no: null });

  // Seeds the title from the filename with its extension stripped, through the same edit path as a
  // typed title, so it reflects at once and reverts like any other edit.
  const applyFilenameAsTitle = () =>
    void editTrack(live.id, { ...edits, title: filenameStem(live.filename) });

  // A field reads as edited only when its edit is set and truly differs from raw, so the marker never
  // shows for an edit that merely echoes the source.
  const changed = <T,>(edit: T | null, raw: T | null): boolean => edit != null && edit !== raw;

  // Split and Trim open the workbench over the app; a format the cutter cannot slice greys them out
  // with the reason, mirroring the row menu's gate. Placed above the inert File zone, they read as
  // acting on the file without touching the source.
  const spliceable = canSplice(live.ext);
  const spliceButtons = (
    <div className={styles.spliceActions}>
      <QuietButton
        onClick={() => setOpenTool({ verb: "split", trackId: live.id })}
        disabled={!spliceable}
      >
        <Scissors size={15} strokeWidth={1.8} />
        <span>{t((d) => d.splice.split)}</span>
      </QuietButton>
      <QuietButton
        onClick={() => setOpenTool({ verb: "trim", trackId: live.id })}
        disabled={!spliceable}
      >
        <Crop size={15} strokeWidth={1.8} />
        <span>{t((d) => d.splice.trim)}</span>
      </QuietButton>
    </div>
  );
  const spliceActions = spliceable ? (
    spliceButtons
  ) : (
    <Tooltip label={t((d) => d.splice.unsupported)}>{spliceButtons}</Tooltip>
  );

  return (
    <aside className={styles.drawer} aria-label={t((d) => d.tracks.details)}>
      <ScrollArea className={styles.scroll} contentClassName={styles.inner}>
        <div className={styles.head}>
          <div className={styles.hero}>
            <TagField
              big
              value={live.title_edit ?? live.raw_title ?? ""}
              ariaLabel={t((d) => d.tracks.fields.title)}
              placeholder={live.filename}
              edited={changed(live.title_edit, live.raw_title)}
              onCommit={commitText("title", live.raw_title)}
              onRevert={revertText("title")}
            />
            <div className={styles.fromFilename}>
              <QuietButton onClick={applyFilenameAsTitle}>
                {t((d) => d.tracks.useFilenameAsTitle)}
              </QuietButton>
            </div>
          </div>
          <QuietButton onClick={onClose} aria-label={t((d) => d.common.closeDetails)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        <TrackDetailCover track={live} keepOwn={keepOwnCover?.value ?? false} />

        <section className={styles.zone}>
          <h3 className={styles.zoneLabel}>{t((d) => d.tracks.sectionTags)}</h3>
          <div className={styles.tags}>
            <TagField
              label={t((d) => d.tracks.fields.artist)}
              value={live.artist_edit ?? live.raw_artist ?? ""}
              ariaLabel={t((d) => d.tracks.fields.artist)}
              edited={changed(live.artist_edit, live.raw_artist)}
              onCommit={commitText("artist", live.raw_artist)}
              onRevert={revertText("artist")}
            />
            <TagField
              label={t((d) => d.tracks.fields.album)}
              value={live.album_edit ?? albumFallback?.album ?? live.raw_album ?? ""}
              ariaLabel={t((d) => d.tracks.fields.album)}
              edited={changed(live.album_edit, live.raw_album)}
              onCommit={commitText("album", live.raw_album)}
              onRevert={revertText("album")}
            />
            <TagField
              label={t((d) => d.tracks.fields.albumArtist)}
              value={live.album_artist_edit ?? albumFallback?.album_artist ?? live.raw_album_artist ?? ""}
              ariaLabel={t((d) => d.tracks.fields.albumArtist)}
              edited={changed(live.album_artist_edit, live.raw_album_artist)}
              onCommit={commitText("album_artist", live.raw_album_artist)}
              onRevert={revertText("album_artist")}
            />
            <TagField
              label={t((d) => d.tracks.fields.year)}
              value={formatYear(live.year_edit ?? albumFallback?.year ?? live.raw_year)}
              ariaLabel={t((d) => d.tracks.fields.year)}
              edited={changed(live.year_edit, live.raw_year)}
              onCommit={commitYear}
              onRevert={revertYear}
            />
            <TagField
              label={t((d) => d.tracks.fields.discNo)}
              value={formatDisc(live.disc_edit ?? live.raw_disc_no)}
              ariaLabel={t((d) => d.tracks.fields.discNo)}
              edited={changed(live.disc_edit, live.raw_disc_no)}
              onCommit={commitDisc}
              onRevert={revertDisc}
            />
            <div className={styles.tag}>
              <span className={styles.label}>{t((d) => d.tracks.fields.genre)}</span>
              <TrackGenres trackId={live.id} genreIds={live.genre_ids} />
            </div>
            {keepOwnCover ? (
              <KeepOwnCoverToggle
                trackId={live.id}
                keepOwnCover={keepOwnCover.value}
                onChange={keepOwnCover.onChange}
              />
            ) : null}
          </div>
        </section>

        {spliceActions}

        <section className={`${styles.zone} ${styles.fileZone}`}>
          <h3 className={styles.zoneLabel}>{t((d) => d.tracks.sectionFile)}</h3>
          <dl className={styles.facts}>
            {fileFactsOf(live, t).map((fact) => (
              <div className={styles.fact} key={fact.label}>
                <dt className={styles.label}>{fact.label}</dt>
                <dd className={`${styles.value} ${fact.mono ? styles.mono : ""}`}>
                  {show(fact.value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </ScrollArea>
    </aside>
  );
}
