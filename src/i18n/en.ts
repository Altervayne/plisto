/*
 * The English dictionary: the source of truth for every user-facing string. Object-literal strings
 * widen to `string` (no `as const`), so `Dict` carries `string` and `Plural` leaves that the French
 * scaffold must match key-for-key. A `{name}` token marks a raw interpolation slot; a `{{name}}`
 * token formats its value as a locale-aware number (grouped per the active locale); a nested
 * one/other leaf drives count text, chosen by `n`.
 */

export const en = {
  nav: {
    library: "Library",
    files: "Files",
    albums: "Albums",
    singles: "Singles",
    output: "Output",
    export: "Export",
  },

  common: {
    undo: "Undo",
    redo: "Redo",
    clear: "Clear",
    cancel: "Cancel",
    dismiss: "Dismiss",
    close: "Close",
    closeDetails: "Close details",
    rescan: "Re-scan",
    changeFolder: "Change folder",
  },

  scan: {
    pickerTitle: "Choose your music folder",
    pickerSafety: "Your files are read only. Plisto never moves, renames, or changes them.",
    chooseFolder: "Choose folder...",
    scanningTitle: "Scanning your library",
    unreadable: "unreadable",
    failedTitle: "Scan failed",
    failedLine: "The scan could not finish. Your files are untouched.",
    tryAgain: "Try again",
    emptyTitle: "No audio files here",
    emptyLine: "This folder holds no tracks Plisto can read. Try another one.",
  },

  selection: {
    selected: "selected",
    actions: "Selection actions",
    createAlbum: "Create album",
    addToAlbum: "Add to album...",
    createError: "Could not create the album.",
    pickerTitle: "Add to album",
    noAlbums: "No albums yet - Create one.",
    findAlbum: "Find album",
    noAlbumMatch: 'No album matches "{q}"',
  },

  albums: {
    emptyTitle: "No albums yet",
    emptyLine: "Open Files, select tracks, and Create album.",
    untitled: "Untitled",
    unknownArtist: "Unknown artist",
    details: "Album details",
    albumTitle: "Album title",
    albumArtist: "Album artist",
    year: "Year",
    genre: "Genre",
    addGenre: "+ add genre",
    tracks: "Tracks",
    noTracks: "No tracks in this album.",
    delete: "Delete album",
    deleteConfirm: "Delete this album?",
    deleteAction: "Delete",
    reorderTrack: "Reorder track",
    trackTitle: "Track title",
    edited: "edited",
    revert: "revert",
    trackCount: { one: "{{n}} track", other: "{{n}} tracks" },
    tracksMissing: { one: "{{n}} track missing", other: "{{n}} tracks missing" },
  },

  singles: {
    emptyTitle: "No singles yet",
    emptyLine: "Pick a standalone track in Files and mark it a single.",
    marker: "Single",
    details: "Single details",
    source: "Source",
    make: { one: "Make single", other: "Make {{n}} singles" },
    makeError: "Could not make the single.",
    remove: "Remove single",
    removeConfirm: "Remove this single?",
    removeAction: "Remove",
  },

  cover: {
    trackLabel: "Cover",
    albumLabel: "Album cover",
    add: "Add cover",
    replace: "Replace cover",
    embedNote: "covers embed into the exported copy, never your originals",
    setError: "Could not set the cover.",
    none: "No cover found",
    embedded: "Embedded in file",
    inFolder: "In this folder: {name}",
    inFolderPlain: "In this folder",
    imported: "Added by you (cached) - not written to your files",
    addedByYou: "Added by you",
    useThis: "Use this",
    removeAdded: "Remove the cover you added",
  },

  tracks: {
    search: "Search tracks",
    noMatch: 'No tracks match "{q}"',
    selectAll: "Select all",
    clearSelection: "Clear selection",
    selectTrack: "Select track",
    deselectTrack: "Deselect track",
    details: "Track details",
    columns: {
      raw_track_no: "No",
      raw_title: "Title",
      raw_artist: "Artist",
      raw_album: "Album",
      raw_year: "Year",
      duration_secs: "Length",
      ext: "Format",
      filename: "File",
    },
    fields: {
      title: "Title",
      artist: "Artist",
      album: "Album",
      albumArtist: "Album artist",
      trackNo: "Track no",
      discNo: "Disc no",
      year: "Year",
      genre: "Genre",
      length: "Length",
      format: "Format",
      size: "Size",
      modified: "Modified",
      indexed: "Indexed",
      filename: "Filename",
      sourcePath: "Source path",
    },
  },

  files: {
    folders: "Folders",
    allFiles: "All files",
    fileView: "File view",
    folderPath: "Folder path",
    upOneLevel: "Up one level",
    folderTracks: { one: "{{n}} track", other: "{{n}} tracks" },
    folderSubfolders: { one: "{{n}} folder", other: "{{n}} folders" },
  },

  export: {
    title: "Export library",
    exporting: "Exporting",
    exported: "Exported",
    chooseFolder: "Choose folder...",
    action: "Export",
    confirm: "Export anyway",
    cancel: "Cancel",
    albums: { one: "{{n}} album", other: "{{n}} albums" },
    tracks: { one: "{{n}} track", other: "{{n}} tracks" },
    singles: { one: "{{n}} single", other: "{{n}} singles" },
    unsorted: { one: "{{n}} unsorted (won't export)", other: "{{n}} unsorted (won't export)" },
    missing: { one: "{{n}} track missing its source", other: "{{n}} tracks missing their source" },
    insideWorkspace: "This folder is inside your music library. Choose one outside it.",
    nonEmpty: "This folder already holds files. Export writes into it.",
    openFolder: "Open destination folder",
    again: "Export again",
    written: { one: "{{n}} exported", other: "{{n}} exported" },
    skipped: { one: "{{n}} skipped", other: "{{n}} skipped" },
    errors: { one: "{{n}} error", other: "{{n}} errors" },
    more: "and {{n}} more",
  },

  resizer: {
    panel: "Resize panel",
    folders: "Resize folders",
  },

  window: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
  },
};

/** The full dictionary shape, derived from the English source. The French scaffold is typed to it. */
export type Dict = typeof en;
