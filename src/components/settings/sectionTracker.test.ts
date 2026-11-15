// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { FakeObserver, fakeViewport, stubBrowser } from "./domFakes";
import { createSectionTracker, releasesLock } from "./sectionTracker";
import type { SectionLock } from "./sectionTracker";

afterEach(() => vi.unstubAllGlobals());

const SECTIONS = {
  folders: 0,
  genres: 400,
  playback: 800,
  sound: 1100,
  appearance: 1700,
  system: 2000,
  plugins: 2400,
  updates: 2800,
};

describe("releasesLock", () => {
  it("releases on keys that scroll and not on Tab or letters", () => {
    for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]) {
      expect(releasesLock(key)).toBe(true);
    }
    for (const key of ["Tab", "Enter", "a", "Escape"]) expect(releasesLock(key)).toBe(false);
  });
});

describe("createSectionTracker", () => {
  it("re-measures when the content resizes without a scroll", () => {
    const browser = stubBrowser();
    const { viewport, setTop } = fakeViewport(SECTIONS);
    const seen: string[] = [];
    createSectionTracker(viewport, (id) => seen.push(id), { current: null });
    browser.runFrames();
    expect(seen[seen.length - 1]).toBe("folders");

    // Scrolled to 700 with no scroll event: Sound (1100) is still below the line. The content above
    // it then shrinks, Sound's top moves up to 600, and only the resize can tell the tracker.
    viewport.scrollTop = 700;
    setTop("sound", 600);
    FakeObserver.fireAll();
    browser.runFrames();
    expect(seen[seen.length - 1]).toBe("sound");
  });

  it("observes both the viewport and its content", () => {
    stubBrowser();
    const { viewport } = fakeViewport(SECTIONS);
    createSectionTracker(viewport, vi.fn(), { current: null });
    expect(FakeObserver.all[0].observed).toEqual([viewport, viewport.firstElementChild]);
  });

  it("measures once per frame however many scrolls arrive", () => {
    const browser = stubBrowser();
    const { viewport, own } = fakeViewport(SECTIONS);
    const onActive = vi.fn();
    createSectionTracker(viewport, onActive, { current: null });
    own.fire("scroll");
    own.fire("scroll");
    browser.runFrames();
    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("holds a locked section through Tab and releases on a scroll key or the wheel", () => {
    const browser = stubBrowser();
    const { viewport, surface } = fakeViewport(SECTIONS);
    const lock: SectionLock = { current: "updates" };
    const onActive = vi.fn();
    createSectionTracker(viewport, onActive, lock);
    browser.runFrames();
    expect(onActive).not.toHaveBeenCalled();

    surface.fire("keydown", { key: "Tab" });
    expect(lock.current).toBe("updates");
    surface.fire("keydown", { key: "ArrowDown" });
    expect(lock.current).toBeNull();

    lock.current = "updates";
    surface.fire("wheel");
    expect(lock.current).toBeNull();
  });

  it("removes its listeners and observer on dispose", () => {
    stubBrowser();
    const { viewport, surface, own } = fakeViewport(SECTIONS);
    createSectionTracker(viewport, vi.fn(), { current: null }).dispose();
    expect(surface.count("wheel")).toBe(0);
    expect(surface.count("keydown")).toBe(0);
    expect(own.count("scroll")).toBe(0);
    expect(FakeObserver.all[0].disconnected).toBe(true);
  });
});
