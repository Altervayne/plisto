// -- Framework Imports --
import { useState } from "react";
import type { KeyboardEvent } from "react";

// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// -- Icon Imports --
import {
  ChevronRight,
  GripVertical,
  ListEnd,
  ListOrdered,
  ListStart,
  Maximize2,
  Play,
  Ungroup,
  X,
} from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";
import { IconToggle } from "../common/IconToggle";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { PlaylistAlbumMember } from "./PlaylistAlbumMember";

// -- Hook Imports --
import { useAlbumCover } from "../albums/useAlbumCover";

// -- State Imports --
import { useAlbum } from "../../state/organize/store";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

// -- Utils Imports --
import { hasPlayableMember, missingCount, totalSecs } from "./albumEntryPlay";
import type { AlbumEntry } from "./albumEntryPlay";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistAlbumRow.module.css";

/**
 * One album entry in the playlist: a live reference to an album, shown as one sortable row. The head
 * carries the grip, the entry's number (a play triangle on hover), the cover and the album's own title,
 * artist and year, the Keep in the same order toggle, the total length (a remove on hover) and a chevron
 * that unfolds the members. The unfolded panel shares the entry's wrapper, so head and members read as one
 * surface. An entry folds while it is dragged, so the gap the list measures is one row high.
 *
 * Until the album projection loads (`ready` false) the members are unknown: the row reads as loading and
 * its play and unfold stay inert, never an empty album. `onPlayFrom` takes a member index and starts the
 * playlist there; the other callbacks act on the whole entry. `defaultOpen` starts the entry unfolded.
 */
export function PlaylistAlbumRow({
  entry,
  displayNo,
  ready,
  playerEnabled,
  onPlayFrom,
  onPlayNext,
  onAddToQueue,
  onOpenAlbum,
  onSetKeep,
  onUnpack,
  onRemove,
  defaultOpen = false,
}: {
  entry: AlbumEntry;
  displayNo: number;
  ready: boolean;
  playerEnabled: boolean;
  onPlayFrom: (memberIndex: number) => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onOpenAlbum: () => void;
  onSetKeep: (keep: boolean) => void;
  onUnpack: () => void;
  onRemove: () => void;
  defaultOpen?: boolean;
}) {
  const t = useT();
  const menu = useContextMenu();
  const album = useAlbum(entry.entry.album_id);
  const { src } = useAlbumCover(entry.entry.album_id, "thumb");
  const [open, setOpen] = useState(defaultOpen);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const { members } = entry;
  const kept = entry.entry.keep_order;
  const missing = missingCount(members);
  const allMissing = ready && members.length > 0 && missing === members.length;
  const playable = ready && hasPlayableMember(members);
  const unfolded = open && ready && !isDragging;
  const unplayableReason =
    ready && !playable ? t((d) => d.player.fileMissing) : undefined;

  const title = album?.title ?? t((d) => d.albums.untitled);
  const meta = [
    album?.album_artist,
    album?.year,
    t((d) => d.albums.trackCount, { n: members.length }),
  ]
    .filter((part) => part != null && part !== "")
    .join(" - ");
  const warn = allMissing
    ? t((d) => d.playlists.albumEntry.allMissing)
    : missing > 0
      ? t((d) => d.playlists.albumEntry.missing, { n: missing })
      : null;

  const toggle = () => {
    if (ready) setOpen((was) => !was);
  };
  const onHeadKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  const keepLabel = t((d) => d.playlists.albumEntry.keepOrder);
  const keepTip = kept
    ? t((d) => d.playlists.albumEntry.keepTipOn)
    : t((d) => d.playlists.albumEntry.keepTipOff);

  const buildMenu = (): MenuEntry[] => [
    ...(playerEnabled
      ? [
          {
            icon: <Play size={16} strokeWidth={1.8} />,
            label: t((d) => d.player.play),
            onSelect: () => onPlayFrom(0),
            disabled: !playable,
            tooltip: unplayableReason,
          } satisfies MenuEntry,
          {
            icon: <ListStart size={16} strokeWidth={1.8} />,
            label: t((d) => d.player.playNext),
            onSelect: onPlayNext,
            disabled: !playable,
            tooltip: unplayableReason,
          } satisfies MenuEntry,
          {
            icon: <ListEnd size={16} strokeWidth={1.8} />,
            label: t((d) => d.player.addToQueue),
            onSelect: onAddToQueue,
            disabled: !playable,
            tooltip: unplayableReason,
          } satisfies MenuEntry,
          { separator: true } satisfies MenuEntry,
        ]
      : []),
    {
      icon: <ListOrdered size={16} strokeWidth={1.8} />,
      label: keepLabel,
      checked: kept,
      onSelect: () => onSetKeep(!kept),
    },
    {
      icon: <Maximize2 size={16} strokeWidth={1.8} />,
      label: t((d) => d.playlists.albumEntry.openAlbum),
      onSelect: onOpenAlbum,
    },
    {
      icon: <Ungroup size={16} strokeWidth={1.8} />,
      label: t((d) => d.playlists.albumEntry.unpack),
      onSelect: onUnpack,
    },
    { separator: true },
    {
      icon: <X size={16} strokeWidth={1.8} />,
      label: t((d) => d.playlists.removeTrack),
      style: "destructive",
      onSelect: onRemove,
    },
  ];

  const playGlyph = (
    <span
      className={playable ? styles.play : `${styles.play} ${styles.playOff}`}
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        if (playable) onPlayFrom(0);
      }}
    >
      <Play size={12} strokeWidth={2} fill="currentColor" />
    </span>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={styles.entry}
      data-open={unfolded ? "" : undefined}
      data-dragging={isDragging ? "" : undefined}
      onContextMenu={menu.onContextMenu}
    >
      <div
        className={styles.head}
        data-loading={ready ? undefined : ""}
        data-all-missing={allMissing ? "" : undefined}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={onHeadKey}
      >
        <button
          type="button"
          className={styles.handle}
          aria-label={t((d) => d.playlists.albumEntry.reorder)}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} strokeWidth={1.8} />
        </button>

        <div className={styles.numCell}>
          <span className={styles.no}>{displayNo}</span>
          {playerEnabled ? (ready && !playable ? <Tooltip label={unplayableReason}>{playGlyph}</Tooltip> : playGlyph) : null}
        </div>

        <div className={styles.main}>
          <span className={styles.cover}>
            {ready ? <Cover src={src} alt="" /> : <span className={styles.coverSkeleton} />}
          </span>
          <div className={styles.text}>
            {ready ? (
              <span className={styles.title}>{title}</span>
            ) : (
              <span className={styles.streak} aria-hidden="true" />
            )}
            <span className={styles.meta}>
              {ready ? meta : t((d) => d.playlists.albumEntry.loading)}
              {ready && warn ? <span className={styles.warn}> - {warn}</span> : null}
            </span>
          </div>
        </div>

        <div className={styles.trail}>
          <Tooltip label={keepTip}>
            <IconToggle
              size="sm"
              pressed={kept}
              aria-label={keepLabel}
              onClick={(e) => {
                e.stopPropagation();
                onSetKeep(!kept);
              }}
            >
              <ListOrdered size={16} strokeWidth={1.8} />
            </IconToggle>
          </Tooltip>
          <span className={styles.lengthCell}>
            <span className={`${styles.length} tabular`}>
              {ready ? formatDuration(totalSecs(members)) : ""}
            </span>
            <button
              type="button"
              className={styles.remove}
              aria-label={t((d) => d.playlists.removeTrack)}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          </span>
          <button
            type="button"
            className={styles.chevron}
            aria-label={unfolded ? t((d) => d.playlists.albumEntry.fold) : t((d) => d.playlists.albumEntry.unfold)}
            aria-expanded={unfolded}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
          >
            <ChevronRight size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {unfolded ? (
        <div className={styles.members}>
          {members.map((member, i) => (
            <PlaylistAlbumMember
              key={member.track_id}
              member={member}
              no={i + 1}
              onPlay={playerEnabled ? () => onPlayFrom(i) : undefined}
            />
          ))}
        </div>
      ) : null}

      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={menu.close}
        items={buildMenu()}
        ariaLabel={title}
      />
    </div>
  );
}
