// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ProjectionPending } from "./ProjectionPending";

const h = vi.hoisted(() => ({ spinning: true }));

vi.mock("../../hooks/useDelayedFlag", () => ({ useDelayedFlag: (on: boolean) => on && h.spinning }));
vi.mock("../scan/StaffSpinner", () => ({ StaffSpinner: () => <i data-spinner="" /> }));
vi.mock("../../state/organize/store", () => ({ orgLoader: { wake: () => {} } }));
vi.mock("../../state/playlists/store", () => ({ playlistsLoader: { wake: () => {} } }));

describe("ProjectionPending", () => {
  it("shows the spinner and the loading line once the wait is noticeable", () => {
    h.spinning = true;
    const html = renderToStaticMarkup(<ProjectionPending state="loading" />);
    expect(html).toContain("data-spinner");
    expect(html).toContain("Loading albums and playlists");
    expect(html).not.toContain("Try again");
  });

  it("shows nothing yet while the delay has not passed", () => {
    h.spinning = false;
    const html = renderToStaticMarkup(<ProjectionPending state="loading" />);
    expect(html).not.toContain("data-spinner");
    expect(html).not.toContain("Loading albums");
  });

  it("offers Try again once stalled", () => {
    const html = renderToStaticMarkup(<ProjectionPending state="stalled" />);
    expect(html).toContain("Albums and playlists have not loaded yet");
    expect(html).toContain("Nothing in your library has changed");
    expect(html).toContain("Try again");
  });

  it("renders nothing when ready", () => {
    expect(renderToStaticMarkup(<ProjectionPending state="ready" />)).toBe("");
  });
});
