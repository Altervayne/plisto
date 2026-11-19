// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { TagAlbumsBand } from "./TagAlbumsBand";
import { TagAlbumsLead } from "./TagAlbumsLead";
import { TagAlbumsPointer } from "./TagAlbumsPointer";

// -- i18n Imports --
import { createT } from "../../../i18n";

const summary = { keys: [], albumCount: 1284, trackCount: 18402, looseCount: 21730 };

describe("TagAlbumsBand", () => {
  it("formats large counts and offers review and dismissal", () => {
    const html = renderToStaticMarkup(
      <TagAlbumsBand summary={summary} eyebrow={false} onReview={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain("1,284 albums can be built from your tags");
    expect(html).toContain("18,402 of your 21,730 unsorted tracks share album tags.");
    expect(html).toContain("Review albums");
    expect(html).toContain("Not now");
    expect(html).not.toContain("Whole library");
  });

  it("reads singular for one album", () => {
    const html = renderToStaticMarkup(
      <TagAlbumsBand
        summary={{ ...summary, albumCount: 1, trackCount: 1 }}
        eyebrow
        onReview={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("1 album can be built from your tags");
    expect(html).toContain("Whole library");
  });

  it("carries French copy whole, with its accents", () => {
    const t = createT("fr");
    expect(t((d) => d.tagAlbums.bandTitle, { n: 1284 })).toContain("peuvent être créés depuis vos tags");
    expect(t((d) => d.tagAlbums.bandTitle, { n: 1 })).toBe("1 album peut être créé depuis vos tags");
    expect(t((d) => d.tagAlbums.bandSub, { n: 18402, m: 21730 })).toContain("partagent des tags d'album");
    expect(t((d) => d.tagAlbums.bandReview)).toBe("Vérifier les albums");
    expect(t((d) => d.tagAlbums.bandDismiss)).toBe("Pas maintenant");
    expect(t((d) => d.tagAlbums.bandEyebrow)).toBe("Toute l'audiothèque");
  });
});

describe("TagAlbumsLead and TagAlbumsPointer", () => {
  it("say what the tags can make and offer the review", () => {
    const lead = renderToStaticMarkup(<TagAlbumsLead albumCount={12} onReview={() => {}} />);
    expect(lead).toContain("12 albums can be built from tags");
    expect(lead).toContain("Review");
    const pointer = renderToStaticMarkup(<TagAlbumsPointer albumCount={1} onReview={() => {}} />);
    expect(pointer).toContain("Your unsorted tracks can make 1 album from their tags.");
    expect(pointer).toContain("Review albums");
  });
});
