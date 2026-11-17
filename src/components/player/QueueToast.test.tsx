// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// -- Unit Imports --
import { QueueToast } from "./QueueToast";

// -- Type Imports --
import type { QueueNotice } from "../../state/player/queueToast";

const h = vi.hoisted(() => ({ notice: { kind: "added", count: 1 } as QueueNotice }));

vi.mock("../../state/player/queueToast", () => ({
  useQueueToast: () => ({ notice: h.notice, visible: true }),
}));
vi.mock("../common/Toast/Toast", () => ({
  Toast: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const render = () => renderToStaticMarkup(<QueueToast />);

beforeEach(() => {
  h.notice = { kind: "added", count: 1 };
});

describe("QueueToast", () => {
  it("reads an append as a count", () => {
    expect(render()).toContain("Added to queue");
    h.notice = { kind: "added", count: 3 };
    expect(render()).toContain("Added 3 to queue");
  });

  it("names the plugin that keeps playing after a clear", () => {
    h.notice = { kind: "cleared", name: "Night Radio" };
    expect(render()).toContain("Queue cleared. Night Radio keeps playing.");
  });

  it("drops the second sentence when there is no name", () => {
    h.notice = { kind: "clearedPlain" };
    const html = render();
    expect(html).toContain("Queue cleared.");
    expect(html).not.toContain("keeps playing");
  });

  it("says where a track sits after play next", () => {
    h.notice = { kind: "playsAfter", title: "Harbor Lights" };
    expect(render()).toContain("Plays after Harbor Lights");
  });

  it("says a play next inside a kept album lands after the album", () => {
    h.notice = { kind: "playsAfterAlbum" };
    expect(render()).toContain("Plays after this album");
  });

  it("names the playlist an album entry was added to, and the default", () => {
    h.notice = { kind: "albumAdded", name: "Night Drive" };
    expect(render()).toContain("Added to Night Drive. Kept in the same order.");
  });

  it("counts the tracks an entry unpacked into", () => {
    h.notice = { kind: "unpacked", count: 9 };
    expect(render()).toContain("Unpacked into 9 tracks");
    h.notice = { kind: "unpacked", count: 1 };
    expect(render()).toContain("Unpacked into 1 track<");
  });
});
