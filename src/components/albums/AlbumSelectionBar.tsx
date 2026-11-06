// -- Framework Imports --
import { useRef, useState } from "react";

// -- Component Imports --
import { FoldedActions } from "../common/ActionFold/FoldedActions";
import { QuietButton } from "../common/QuietButton";

// -- Hook Imports --
import type { MountState } from "../../hooks/useMountTransition";

// -- Type Imports --
import type { FoldAction } from "../common/ActionFold/FoldedActions";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumSelectionBar.module.css";

/**
 * The scoped action bar over an album-track selection, shown at the head of the list only while tracks
 * are selected. It carries the count, a select-all, a move-to-disc menu, an add-to-playlist, a set-cover,
 * the two keep-own-cover toggles, a remove, and a clear, on one line in hairline-parted groups. When the
 * pane narrows the lowest-priority actions fold into a trailing More menu; Clear stays. The move menu
 * lists the album's discs plus one entry for the next new disc. Every action reports up - the parent owns
 * the selection and layout.
 */
export function AlbumSelectionBar({
  count,
  discs,
  newDisc,
  state,
  onSelectAll,
  onPlayNext,
  onAddToQueue,
  onMoveToDisc,
  onExtract,
  onAddToPlaylist,
  onSetCover,
  onKeepOwnCover,
  onUseAlbumCover,
  onRemove,
  onClear,
}: {
  count: number;
  discs: number[];
  newDisc: number;
  state?: MountState;
  onSelectAll: () => void;
  // Absent while the player is off, so the bar simply drops the entry.
  onPlayNext?: () => void;
  onAddToQueue?: () => void;
  onMoveToDisc: (disc: number) => void;
  onExtract: () => void;
  onAddToPlaylist: () => void;
  onSetCover: () => void;
  onKeepOwnCover: () => void;
  onUseAlbumCover: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  // The count empties as the selection clears, but the parent holds the bar through its exit; keep the
  // last real tally so the fade shows it rather than a bare zero.
  const lastCount = useRef(count);
  if (count > 0) lastCount.current = count;

  const selectAllLabel = t((d) => d.albums.selectAll);
  const playNextLabel = t((d) => d.player.playNext);
  const queueLabel = t((d) => d.player.addToQueue);
  const moveLabel = t((d) => d.albums.moveToDisc);
  const extractLabel = t((d) => d.extract.action);
  const playlistLabel = t((d) => d.playlists.addTo);
  const setCoverLabel = t((d) => d.albums.setCover);
  const keepOwnLabel = t((d) => d.albums.keepOwnCover);
  const useAlbumLabel = t((d) => d.albums.useAlbumCover);
  const removeLabel = t((d) => d.albums.removeFromAlbum);

  // Folded into More, Move to disc opens its disc list as a second menu.
  const discSteps = [
    ...discs.map((disc) => ({
      label: t((d) => d.albums.discLabel, { n: disc }),
      onSelect: () => onMoveToDisc(disc),
    })),
    { label: t((d) => d.albums.newDisc, { n: newDisc }), onSelect: () => onMoveToDisc(newDisc) },
  ];

  const plain = (
    id: string,
    keep: number,
    group: number,
    label: string,
    onSelect: () => void,
  ): FoldAction => ({
    id,
    keep,
    group,
    label,
    onSelect,
    node: <QuietButton onClick={onSelect}>{label}</QuietButton>,
  });

  // The actions in display order, grouped for the hairlines; the keep rank says what folds into More
  // last. The player actions drop out while the player is off.
  const actions: FoldAction[] = [
    plain("all", 2, 1, selectAllLabel, onSelectAll),
    ...(onPlayNext ? [plain("next", 1, 2, playNextLabel, onPlayNext)] : []),
    ...(onAddToQueue ? [plain("queue", 3, 2, queueLabel, onAddToQueue)] : []),
    {
      id: "disc",
      keep: 4,
      group: 3,
      label: moveLabel,
      onSelect: () => undefined,
      steps: discSteps,
      measure: <QuietButton>{moveLabel}</QuietButton>,
      node: (
        <div className={styles.moveWrap}>
          <QuietButton onClick={() => setMenuOpen((open) => !open)}>{moveLabel}</QuietButton>
          {menuOpen ? (
            <>
              <div className={styles.backdrop} onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <ul className={styles.menu} role="menu" aria-label={moveLabel}>
                {discSteps.map((step) => (
                  <li key={step.label}>
                    <button
                      type="button"
                      className={styles.option}
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        step.onSelect();
                      }}
                    >
                      {step.label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ),
    },
    plain("extract", 9, 3, extractLabel, onExtract),
    plain("playlist", 6, 4, playlistLabel, onAddToPlaylist),
    plain("cover", 8, 5, setCoverLabel, onSetCover),
    plain("own", 10, 5, keepOwnLabel, onKeepOwnCover),
    plain("usealbum", 11, 5, useAlbumLabel, onUseAlbumCover),
    plain("remove", 5, 6, removeLabel, onRemove),
  ];

  return (
    <div className={styles.bar} data-state={state} role="toolbar" aria-label={t((d) => d.selection.actions)}>
      <span className={styles.count}>{t((d) => d.albums.selected, { n: lastCount.current })}</span>

      <FoldedActions
        className={styles.actions}
        actions={actions}
        trailing={<QuietButton onClick={onClear}>{t((d) => d.common.clear)}</QuietButton>}
        separators
        up={false}
        inset={0}
      />
    </div>
  );
}
