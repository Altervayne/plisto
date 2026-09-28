// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { QuietButton } from "../common/QuietButton";
import { PrimaryButton } from "../common/PrimaryButton";
import { PlaylistCoverField } from "./PlaylistCoverField";
import { PlaylistDescriptionField } from "./PlaylistDescriptionField";
import { PlaylistDeleteControl } from "./PlaylistDeleteControl";
import { PlaylistExportDialog } from "./PlaylistExportDialog";

// -- Icon Imports --
import { Play, Share } from "lucide-react";

// -- Hook Imports --
import { usePlayPlaylist } from "./usePlayPlaylist";

// -- State Imports --
import { useRenamePlaylist, useSetPlaylistDescription } from "../../state/playlists/store";
import { usePlayerEnabled } from "../../state/player/store";

// -- Type Imports --
import type { PlaylistRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistHeader.module.css";

/**
 * The playlist header for the full-pane view: the cover on the left, the big editable name over its
 * description and meta line on the right - laid wide like the album folder header. The name commits a
 * rename and the description its blurb, a null on either clearing it back to the default. The meta line
 * leads with Play, the view's one solid-accent action, then the slot count, export, and delete.
 */
export function PlaylistHeader({
  playlist,
  onDeleted,
}: {
  playlist: PlaylistRow;
  onDeleted: () => void;
}) {
  const rename = useRenamePlaylist();
  const setDescription = useSetPlaylistDescription();
  const playback = usePlayPlaylist(playlist.id);
  const playerEnabled = usePlayerEnabled();
  const t = useT();

  const [exporting, setExporting] = useState(false);

  return (
    <header className={styles.header}>
      <div className={styles.cover}>
        <PlaylistCoverField playlistId={playlist.id} />
      </div>
      <div className={styles.meta}>
        <EditableField
          value={playlist.name ?? ""}
          ariaLabel={t((d) => d.playlists.playlistName)}
          placeholder={t((d) => d.playlists.untitled)}
          big
          onCommit={(next) => void rename(playlist.id, next === "" ? null : next)}
        />
        <PlaylistDescriptionField
          value={playlist.description ?? ""}
          ariaLabel={t((d) => d.playlists.description)}
          placeholder={t((d) => d.playlists.descriptionPlaceholder)}
          onCommit={(next) => void setDescription(playlist.id, next === "" ? null : next)}
        />
        <div className={styles.line}>
          {playerEnabled ? (
            <PrimaryButton onClick={playback.play} disabled={!playback.playable}>
              <Play size={15} strokeWidth={2} fill="currentColor" aria-hidden="true" />
              {t((d) => d.player.play)}
            </PrimaryButton>
          ) : null}
          <span className={styles.count}>
            {t((d) => d.playlists.trackCount, { n: playlist.track_count })}
          </span>
          <QuietButton onClick={() => setExporting(true)}>
            <Share size={15} strokeWidth={1.8} aria-hidden="true" />
            {t((d) => d.playlists.export.action)}
          </QuietButton>
          <PlaylistDeleteControl playlistId={playlist.id} onDeleted={onDeleted} />
        </div>
      </div>

      {exporting ? (
        <PlaylistExportDialog playlist={playlist} onClose={() => setExporting(false)} />
      ) : null}
    </header>
  );
}
