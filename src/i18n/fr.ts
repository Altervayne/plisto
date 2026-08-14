/*
 * The French dictionary: a scaffold typed to `Dict`, so tsc rejects a missing, extra, or wrong-shape
 * key. Every leaf is a placeholder for the real translation to replace - no French lives here yet.
 */

// -- Type Imports --
import type { Dict } from "./en";

export const fr: Dict = {
  nav: {
    library: "[TO COMPLETE]",
    files: "[TO COMPLETE]",
    albums: "[TO COMPLETE]",
  },

  common: {
    undo: "[TO COMPLETE]",
    redo: "[TO COMPLETE]",
    clear: "[TO COMPLETE]",
    cancel: "[TO COMPLETE]",
    dismiss: "[TO COMPLETE]",
    close: "[TO COMPLETE]",
    closeDetails: "[TO COMPLETE]",
    rescan: "[TO COMPLETE]",
    changeFolder: "[TO COMPLETE]",
  },

  scan: {
    pickerTitle: "[TO COMPLETE]",
    pickerSafety: "[TO COMPLETE]",
    chooseFolder: "[TO COMPLETE]",
    scanningTitle: "[TO COMPLETE]",
    unreadable: "[TO COMPLETE]",
    failedTitle: "[TO COMPLETE]",
    failedLine: "[TO COMPLETE]",
    tryAgain: "[TO COMPLETE]",
    emptyTitle: "[TO COMPLETE]",
    emptyLine: "[TO COMPLETE]",
  },

  selection: {
    selected: "[TO COMPLETE]",
    actions: "[TO COMPLETE]",
    createAlbum: "[TO COMPLETE]",
    addToAlbum: "[TO COMPLETE]",
    createError: "[TO COMPLETE]",
    pickerTitle: "[TO COMPLETE]",
    noAlbums: "[TO COMPLETE]",
    findAlbum: "[TO COMPLETE]",
    noAlbumMatch: "[TO COMPLETE]",
  },

  albums: {
    emptyTitle: "[TO COMPLETE]",
    emptyLine: "[TO COMPLETE]",
    untitled: "[TO COMPLETE]",
    unknownArtist: "[TO COMPLETE]",
    details: "[TO COMPLETE]",
    albumTitle: "[TO COMPLETE]",
    albumArtist: "[TO COMPLETE]",
    year: "[TO COMPLETE]",
    genre: "[TO COMPLETE]",
    addGenre: "[TO COMPLETE]",
    tracks: "[TO COMPLETE]",
    noTracks: "[TO COMPLETE]",
    delete: "[TO COMPLETE]",
    deleteConfirm: "[TO COMPLETE]",
    deleteAction: "[TO COMPLETE]",
    reorderTrack: "[TO COMPLETE]",
    trackTitle: "[TO COMPLETE]",
    edited: "[TO COMPLETE]",
    revert: "[TO COMPLETE]",
    trackCount: { one: "[TO COMPLETE]", other: "[TO COMPLETE]" },
    tracksMissing: { one: "[TO COMPLETE]", other: "[TO COMPLETE]" },
  },

  cover: {
    trackLabel: "[TO COMPLETE]",
    albumLabel: "[TO COMPLETE]",
    add: "[TO COMPLETE]",
    replace: "[TO COMPLETE]",
    embedNote: "[TO COMPLETE]",
    setError: "[TO COMPLETE]",
    none: "[TO COMPLETE]",
    embedded: "[TO COMPLETE]",
    inFolder: "[TO COMPLETE]",
    inFolderPlain: "[TO COMPLETE]",
    imported: "[TO COMPLETE]",
    addedByYou: "[TO COMPLETE]",
    useThis: "[TO COMPLETE]",
    removeAdded: "[TO COMPLETE]",
  },

  tracks: {
    search: "[TO COMPLETE]",
    noMatch: "[TO COMPLETE]",
    selectAll: "[TO COMPLETE]",
    clearSelection: "[TO COMPLETE]",
    selectTrack: "[TO COMPLETE]",
    deselectTrack: "[TO COMPLETE]",
    details: "[TO COMPLETE]",
    columns: {
      raw_track_no: "[TO COMPLETE]",
      raw_title: "[TO COMPLETE]",
      raw_artist: "[TO COMPLETE]",
      raw_album: "[TO COMPLETE]",
      raw_year: "[TO COMPLETE]",
      duration_secs: "[TO COMPLETE]",
      ext: "[TO COMPLETE]",
      filename: "[TO COMPLETE]",
    },
    fields: {
      title: "[TO COMPLETE]",
      artist: "[TO COMPLETE]",
      album: "[TO COMPLETE]",
      albumArtist: "[TO COMPLETE]",
      trackNo: "[TO COMPLETE]",
      discNo: "[TO COMPLETE]",
      year: "[TO COMPLETE]",
      genre: "[TO COMPLETE]",
      length: "[TO COMPLETE]",
      format: "[TO COMPLETE]",
      size: "[TO COMPLETE]",
      modified: "[TO COMPLETE]",
      indexed: "[TO COMPLETE]",
      filename: "[TO COMPLETE]",
      sourcePath: "[TO COMPLETE]",
    },
  },

  files: {
    folders: "[TO COMPLETE]",
    allFiles: "[TO COMPLETE]",
    fileView: "[TO COMPLETE]",
    folderPath: "[TO COMPLETE]",
    upOneLevel: "[TO COMPLETE]",
    folderTracks: { one: "[TO COMPLETE]", other: "[TO COMPLETE]" },
    folderSubfolders: { one: "[TO COMPLETE]", other: "[TO COMPLETE]" },
  },

  resizer: {
    panel: "[TO COMPLETE]",
    folders: "[TO COMPLETE]",
  },
};
