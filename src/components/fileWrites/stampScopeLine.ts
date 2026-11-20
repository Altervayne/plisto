// -- Utils Imports --
import type { ScopeInfo } from "../../lib/stampShape";

// -- i18n Imports --
import type { Translate } from "../../i18n";

/** The scope as one line: what the write covers. */
export function scopeLine(t: Translate, info: ScopeInfo): string {
  switch (info.kind) {
    case "album":
      return t((d) => d.fileWrites.stamp.scopeAlbum, {
        album: info.title,
        artist: info.artist,
        tracks: t((d) => d.fileWrites.tracks, { n: info.tracks }),
      });
    case "selection":
      return t((d) => d.fileWrites.stamp.scopeSelection, { n: info.n, album: info.album });
    case "loose":
      return t((d) => d.fileWrites.stamp.scopeLoose, { n: info.n });
    case "single":
      return t((d) => d.fileWrites.stamp.scopeSingle, { title: info.title, artist: info.artist });
    case "library":
      return t((d) => d.fileWrites.stamp.scopeLibrary, {
        tracks: t((d) => d.fileWrites.tracks, { n: info.tracks }),
      });
    case "albums":
      return t((d) => d.fileWrites.stamp.scopeAlbums, { n: info.n });
    case "count":
      return t((d) => d.fileWrites.tracks, { n: info.n });
  }
}
