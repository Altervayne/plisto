// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { BrowseBy, GroupLabel } from "./browseOrder";
import type { Dict } from "../../../i18n/en";

/** The Group by option names, in menu order. */
export const GROUP_BY_LABEL: Record<BrowseBy, (d: Dict) => string> = {
  none: (d) => d.collection.browseGroupNone,
  artist: (d) => d.collection.browseGroupArtist,
  genre: (d) => d.collection.browseGroupGenre,
  year: (d) => d.collection.browseGroupYear,
  recent: (d) => d.collection.browseGroupRecent,
};

/** A group label's text. `nowYear` names the current year for the "earlier this year" bucket. */
export function groupLabelText(label: GroupLabel, t: Translate, nowYear: number): string {
  switch (label.kind) {
    case "artist":
    case "genre":
      return label.value;
    case "unknownArtist":
      return t((d) => d.albums.unknownArtist);
    case "noGenre":
      return t((d) => d.collection.browseNoGenre);
    case "decade":
      return t((d) => d.collection.browseDecade, { decade: label.value });
    case "noYear":
      return t((d) => d.collection.browseNoYear);
    case "recent": {
      const b = label.bucket;
      if (b.span === "week") return t((d) => d.collection.browseThisWeek);
      if (b.span === "month") return t((d) => d.collection.browseLastMonth);
      if (b.span === "thisYear") return t((d) => d.collection.browseEarlierThisYear, { year: nowYear });
      if (b.span === "year") return String(b.year);
      return t((d) => d.collection.browseBefore, { year: b.year });
    }
  }
}
