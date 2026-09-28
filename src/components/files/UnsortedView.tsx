// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { LibraryBrowser } from "./LibraryBrowser";
import { EmptyState } from "../common/EmptyState";
import { AlbumsFromTagsButton } from "../organize/albumsFromTags/AlbumsFromTagsButton";
import { AlbumsFromTagsSheet } from "../organize/albumsFromTags/AlbumsFromTagsSheet";

// -- State Imports --
import { useUnsortedTracks } from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The Unsorted workspace: the folder browser scoped to the loose tracks - those with no album or single
 * membership. Only folders holding an unsorted track appear, so the hierarchy narrows to the still-to-sort
 * pile. It shares the store selection and the floating action bar, so Create album and Add to album
 * organize a track straight out of here and the list shrinks toward empty. When nothing is loose the whole
 * library is sorted, so a calm terminal state stands in for the browser. The albums-from-tags review opens
 * from the header over the folder in view; it lives here rather than in the header so it outlasts the
 * browser when a batch sorts the last loose track.
 */
export function UnsortedView({ onShowAlbums }: { onShowAlbums: () => void }) {
  const t = useT();
  const [review, setReview] = useState<{ id: string; name: string | null } | null>(null);

  return (
    <>
      <LibraryBrowser
        tracks={useUnsortedTracks()}
        emptyState={
          <EmptyState
            tone="good"
            title={t((d) => d.unsorted.emptyTitle)}
            line={t((d) => d.unsorted.emptyLine)}
          />
        }
        headerAction={(scope) => (
          <AlbumsFromTagsButton
            tracks={scope.tracks}
            onOpen={() => setReview({ id: scope.id, name: scope.name })}
          />
        )}
      />
      {review ? (
        <AlbumsFromTagsSheet
          scopeId={review.id}
          folderName={review.name}
          onClose={() => setReview(null)}
          onShowAlbums={onShowAlbums}
        />
      ) : null}
    </>
  );
}
