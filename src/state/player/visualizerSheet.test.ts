// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { PREVIEW_DWELL_MS, useVisualizerSheet } from "./visualizerSheet";

const sheet = () => useVisualizerSheet.getState();

beforeEach(() => {
  vi.useFakeTimers();
  sheet().close();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("visualizer sheet", () => {
  it("toggles open and closed", () => {
    sheet().toggle();
    expect(sheet().isOpen).toBe(true);
    sheet().toggle();
    expect(sheet().isOpen).toBe(false);
  });

  it("previews a kind only after the dwell", () => {
    sheet().open();
    sheet().preview("nebula");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS - 1);
    expect(sheet().previewKind).toBeNull();
    vi.advanceTimersByTime(1);
    expect(sheet().previewKind).toBe("nebula");
  });

  it("lands only the last of several quick changes", () => {
    sheet().open();
    sheet().preview("nebula");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS / 2);
    sheet().preview("latte");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS / 2);
    expect(sheet().previewKind).toBeNull();
    vi.advanceTimersByTime(PREVIEW_DWELL_MS / 2);
    expect(sheet().previewKind).toBe("latte");
  });

  it("does not restart the dwell when the same kind repeats", () => {
    sheet().open();
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS - 20);
    sheet().preview("ink");
    vi.advanceTimersByTime(20);
    expect(sheet().previewKind).toBe("ink");
  });

  it("keeps a landed preview when a change back to it cancels a pending one", () => {
    sheet().open();
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    sheet().preview("silk");
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    expect(sheet().previewKind).toBe("ink");
  });

  it("reverts to the pick after the dwell", () => {
    sheet().open();
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    sheet().preview(null);
    expect(sheet().previewKind).toBe("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    expect(sheet().previewKind).toBeNull();
  });

  it("clears at once on clearPreview, dropping a pending change", () => {
    sheet().open();
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    sheet().preview("silk");
    sheet().clearPreview();
    expect(sheet().previewKind).toBeNull();
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    expect(sheet().previewKind).toBeNull();
  });

  it("drops the preview and any pending change on close", () => {
    sheet().open();
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    sheet().preview("silk");
    sheet().close();
    expect(sheet().previewKind).toBeNull();
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    expect(sheet().previewKind).toBeNull();
  });

  it("ignores a preview while closed", () => {
    sheet().preview("ink");
    vi.advanceTimersByTime(PREVIEW_DWELL_MS);
    expect(sheet().previewKind).toBeNull();
  });
});
