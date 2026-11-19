// -- Framework Imports --
import { useCallback, useState } from "react";
import type { ReactNode } from "react";

// -- Component Imports --
import { AlbumsFromTagsSheet } from "./AlbumsFromTagsSheet";

// -- State Imports --
import { LIBRARY_SCOPE } from "../../../state/files/folderTree";

/**
 * Opens the albums-from-tags review over the whole library from a surface that is not Unsorted. The host
 * renders `sheet` beside its content; the host, not the entry that opened it, owns the sheet, so the
 * receipt outlasts the entry disappearing once its proposals are filed.
 */
export function useLibraryTagReview(onShowAlbums: () => void): { open: () => void; sheet: ReactNode } {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const sheet = isOpen ? (
    <AlbumsFromTagsSheet
      scopeId={LIBRARY_SCOPE}
      folderName={null}
      onClose={close}
      onShowAlbums={() => {
        close();
        onShowAlbums();
      }}
    />
  ) : null;
  return { open, sheet };
}
