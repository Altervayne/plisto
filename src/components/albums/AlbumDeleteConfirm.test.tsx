// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AlbumDeleteConfirm } from "./AlbumDeleteConfirm";

vi.mock("../common/ConfirmDialog/ConfirmDialog", () => ({
  ConfirmDialog: (p: { title?: string; prompt: string; confirmLabel: string }) => (
    <div>
      <b data-title="">{p.title ?? ""}</b>
      <p data-prompt="">{p.prompt}</p>
      <i data-confirm="">{p.confirmLabel}</i>
    </div>
  ),
}));

const text = (html: string, attr: string) =>
  new RegExp(`data-${attr}="">([^<]*)<`).exec(html)?.[1] ?? "";

const render = (o: { single?: boolean; bulk?: boolean; count?: number; inPlaylists?: number }) =>
  renderToStaticMarkup(
    <AlbumDeleteConfirm
      open
      single={o.single ?? false}
      bulk={o.bulk ?? false}
      count={o.count ?? 1}
      inPlaylists={o.inPlaylists ?? 0}
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  );

describe("AlbumDeleteConfirm", () => {
  it("is today's prompt alone when no playlist holds the album", () => {
    const html = render({});
    expect(text(html, "title")).toBe("");
    expect(text(html, "prompt")).toBe("Delete this album?");
  });

  it("adds a title and the line naming the playlists when some do", () => {
    const html = render({ inPlaylists: 2 });
    expect(text(html, "title")).toBe("Delete this album?");
    expect(text(html, "prompt")).toBe(
      "This album is in 2 playlists. Its tracks stay in those playlists as separate tracks.",
    );
  });

  it("reads one playlist in the singular", () => {
    expect(text(render({ inPlaylists: 1 }), "prompt")).toBe(
      "This album is in 1 playlist. Its tracks stay in that playlist as separate tracks.",
    );
  });

  it("keeps the counted title and the undo sentence in bulk, the playlist line between them", () => {
    const html = render({ bulk: true, count: 5, inPlaylists: 3 });
    expect(text(html, "title")).toBe("Delete these 5 albums?");
    expect(text(html, "prompt")).toBe(
      "3 of these albums are in playlists. Their tracks stay in those playlists as separate tracks. This clears the undo history.",
    );
  });

  it("keeps today's bulk prompt when none of the picked albums is in a playlist", () => {
    expect(text(render({ bulk: true, count: 5 }), "prompt")).toBe(
      "Delete these 5 albums? This clears the undo history.",
    );
  });

  it("keeps the single wording and never names playlists for a single", () => {
    const html = render({ single: true });
    expect(text(html, "prompt")).toBe("Remove this single?");
    expect(text(html, "confirm")).toBe("Remove");
  });
});
