// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { QueueBand } from "./QueueBand";

vi.mock("../albums/useAlbumCover", () => ({ useAlbumCover: () => ({ src: null }) }));

const render = (o: Partial<Parameters<typeof QueueBand>[0]> = {}) =>
  renderToStaticMarkup(
    <QueueBand albumId={7} title="Low Tide Radio" length={9} place={null} now={false} dim={false} {...o}>
      <i data-row="" />
      <i data-row="" />
    </QueueBand>,
  );

describe("QueueBand", () => {
  it("names the album and says its tracks are kept together", () => {
    const html = render();
    expect(html).toContain("Low Tide Radio");
    expect(html).toContain("Kept together");
  });

  it("shows the track count while the cursor is outside", () => {
    expect(render()).toContain("9 tracks");
  });

  it("shows the cursor's place while it is inside", () => {
    const html = render({ place: 5, now: true });
    expect(html).toContain("5 of 9");
    expect(html).not.toContain("9 tracks");
  });

  it("marks the live block and the dimmed one", () => {
    expect(render({ now: true })).toContain('data-now=""');
    expect(render({ dim: true })).toContain('data-dim=""');
    expect(render()).not.toContain("data-now");
  });

  it("holds the block's rows under the band", () => {
    const html = render();
    expect(html.match(/data-row=/g)).toHaveLength(2);
  });

  it("drops the name and the cover when the album is unknown", () => {
    const html = render({ albumId: null, title: null });
    expect(html).toContain("Kept together");
    expect(html).not.toContain("Low Tide Radio");
    expect(html).not.toContain("<img");
  });
});
