// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { FakeObserver, fakeEl, fakeViewport, stubBrowser } from "./domFakes";
import { SETTLE_MS, consumeTarget, createLandingHold, land, rescueFocus } from "./settingsLanding";
import { MARK_HOLD_MS, MARK_FADE_MS, MARK_REDUCED_HOLD_MS } from "./landingMark";
import { hubSettingId, settingAnchorId } from "./settingsRegistry";
import { openSettings, takeSettingsTarget } from "../../state/shell/store";

const SECTIONS = {
  folders: 0,
  genres: 400,
  playback: 800,
  sound: 1100,
  visualizers: 1500,
  appearance: 1700,
  system: 2000,
  plugins: 2400,
  updates: 2800,
};

/** A row inside a section, with one control. */
function fakeRow(top: number, section: string) {
  const focus = vi.fn();
  const row = fakeEl(top, {
    closest: () => ({ dataset: { settingsSection: section } }),
    querySelector: () => ({ focus }),
  });
  return { row, focus };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  takeSettingsTarget();
});

describe("land", () => {
  it("pins a row 24px below the top, marks and focuses it", () => {
    const theme = fakeRow(500, "appearance");
    stubBrowser({ rows: { [settingAnchorId("theme")]: theme.row } });
    const { viewport } = fakeViewport(SECTIONS);
    expect(land(viewport, "theme")).not.toBeNull();
    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 476, behavior: "instant" });
    expect(theme.row.dataset.landed).toBe("hold");
    expect(theme.focus).toHaveBeenCalledTimes(1);
  });

  it("falls back to the section for a row that is not on the page", () => {
    stubBrowser();
    const { viewport } = fakeViewport(SECTIONS);
    expect(land(viewport, "defaultApp")).not.toBeNull();
    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "instant" });
  });

  it("returns null when nothing answers to the target", () => {
    stubBrowser();
    const { viewport } = fakeViewport(SECTIONS);
    expect(land(viewport, "nope")).toBeNull();
  });

  it("upgrades from the section to a hub row that renders inside the settle window", () => {
    const rows: Record<string, unknown> = {};
    stubBrowser({ rows });
    const { viewport } = fakeViewport(SECTIONS);
    const id = hubSettingId("tandem");
    const landing = land(viewport, id);
    expect(landing).not.toBeNull();
    expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 2400, behavior: "instant" });

    const hub = fakeRow(2500, "plugins");
    rows[settingAnchorId(id)] = hub.row;
    FakeObserver.fireAll();
    expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 2476, behavior: "instant" });
    expect(hub.row.dataset.landed).toBe("hold");
    expect(hub.focus).toHaveBeenCalledTimes(1);

    // A later tick pins again but marks and focuses only once.
    FakeObserver.fireAll();
    expect(hub.focus).toHaveBeenCalledTimes(1);
  });

  it("fades the mark once and clears it", () => {
    const theme = fakeRow(500, "appearance");
    stubBrowser({ rows: { [settingAnchorId("theme")]: theme.row } });
    const { viewport } = fakeViewport(SECTIONS);
    land(viewport, "theme");
    vi.advanceTimersByTime(MARK_HOLD_MS);
    expect(theme.row.dataset.landed).toBe("fade");
    vi.advanceTimersByTime(MARK_FADE_MS);
    expect(theme.row.dataset.landed).toBeUndefined();
  });

  it("holds the mark static under reduced motion and dismisses it on a key press", () => {
    const theme = fakeRow(500, "appearance");
    const browser = stubBrowser({ reduced: true, rows: { [settingAnchorId("theme")]: theme.row } });
    const { viewport } = fakeViewport(SECTIONS);
    land(viewport, "theme");
    vi.advanceTimersByTime(MARK_HOLD_MS + MARK_FADE_MS);
    expect(theme.row.dataset.landed).toBe("hold");
    browser.doc.fire("keydown");
    expect(theme.row.dataset.landed).toBeUndefined();
  });

  it("removes a reduced-motion mark after its hold with no fade phase", () => {
    const theme = fakeRow(500, "appearance");
    stubBrowser({ reduced: true, rows: { [settingAnchorId("theme")]: theme.row } });
    const { viewport } = fakeViewport(SECTIONS);
    land(viewport, "theme");
    vi.advanceTimersByTime(MARK_REDUCED_HOLD_MS);
    expect(theme.row.dataset.landed).toBeUndefined();
  });

  it("stops observing after the settle window", () => {
    stubBrowser();
    const { viewport } = fakeViewport(SECTIONS);
    land(viewport, "sound");
    expect(FakeObserver.all[0].disconnected).toBe(false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(FakeObserver.all[0].disconnected).toBe(true);
  });

  it("stop ends the mark, the observer and the listeners", () => {
    const theme = fakeRow(500, "appearance");
    const browser = stubBrowser({ reduced: true, rows: { [settingAnchorId("theme")]: theme.row } });
    const { viewport, surface } = fakeViewport(SECTIONS);
    const landing = land(viewport, "theme")!;
    landing.stop();
    expect(theme.row.dataset.landed).toBeUndefined();
    expect(FakeObserver.all[0].disconnected).toBe(true);
    expect(surface.count("wheel")).toBe(0);
    expect(browser.doc.count("keydown")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("consumeTarget", () => {
  it("takes the target once", () => {
    stubBrowser();
    const { viewport } = fakeViewport(SECTIONS);
    openSettings({ target: "sound" });
    expect(consumeTarget(viewport)).not.toBeNull();
    expect(consumeTarget(viewport)).toBeNull();
  });
});

describe("createLandingHold", () => {
  const landing = () => ({ stop: vi.fn() });

  it("survives a development effect double-run", () => {
    const hold = createLandingHold();
    const running = landing();
    hold.retain();
    hold.start(running);
    hold.release();
    hold.retain();
    vi.advanceTimersByTime(10);
    expect(running.stop).not.toHaveBeenCalled();
  });

  it("stops the landing on a real unmount", () => {
    const hold = createLandingHold();
    const running = landing();
    hold.retain();
    hold.start(running);
    hold.release();
    vi.advanceTimersByTime(10);
    expect(running.stop).toHaveBeenCalledTimes(1);
  });

  it("ends the previous landing when a new one starts", () => {
    const hold = createLandingHold();
    const first = landing();
    hold.start(first);
    hold.start(landing());
    expect(first.stop).toHaveBeenCalledTimes(1);
  });
});

describe("createLandingHold.stop", () => {
  it("ends the running landing at once, as a section change does", () => {
    const hold = createLandingHold();
    const running = { stop: vi.fn() };
    hold.start(running);
    hold.stop();
    expect(running.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(running.stop).toHaveBeenCalledTimes(1);
  });

  it("a landing observer stops placing once stopped", () => {
    const theme = fakeRow(500, "appearance");
    stubBrowser({ rows: { [settingAnchorId("theme")]: theme.row } });
    const { viewport } = fakeViewport(SECTIONS);
    const hold = createLandingHold();
    hold.start(land(viewport, "theme")!);
    hold.stop();
    const calls = viewport.scrollTo.mock.calls.length;
    FakeObserver.fireAll();
    expect(viewport.scrollTo.mock.calls.length).toBe(calls);
  });
});

describe("rescueFocus", () => {
  function fakeDoc(active: unknown, navs: Array<{ offsetParent: unknown; focus: () => void }>) {
    return {
      body: { name: "body" },
      activeElement: active,
      querySelectorAll: () => navs,
    } as unknown as Document;
  }

  it("moves focus from the body to the visible nav entry", () => {
    const hidden = { offsetParent: null, focus: vi.fn() };
    const shown = { offsetParent: {}, focus: vi.fn() };
    const doc = fakeDoc(null, [hidden, shown]);
    rescueFocus(doc);
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(shown.focus).toHaveBeenCalledTimes(1);
  });

  it("rescues focus held inside a hidden page, blurring it first", () => {
    const blur = vi.fn();
    const shown = { offsetParent: {}, focus: vi.fn() };
    const active = { closest: () => ({}), blur };
    rescueFocus(fakeDoc(active, [shown]));
    expect(blur).toHaveBeenCalled();
    expect(shown.focus).toHaveBeenCalled();
  });

  it("leaves focus that is on a visible control alone", () => {
    const shown = { offsetParent: {}, focus: vi.fn() };
    const active = { closest: () => null, blur: vi.fn() };
    rescueFocus(fakeDoc(active, [shown]));
    expect(shown.focus).not.toHaveBeenCalled();
  });
});
