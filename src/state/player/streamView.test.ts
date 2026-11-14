// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  hasKnownLength,
  resolveStream,
  showsPause,
  showsScrubber,
  skipAllowed,
  streamLines,
  waitingPhase,
} from "./streamView";
import { streamNowFixture } from "./streamFixtures";

// -- i18n Imports --
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

describe("showsPause", () => {
  it.each(["connecting", "buffering", "reconnecting", "playing"] as const)("reads Pause in %s", (state) => {
    expect(showsPause(streamNowFixture({ state }))).toBe(true);
  });

  it("reads Play only in paused", () => {
    expect(showsPause(streamNowFixture({ state: "paused" }))).toBe(false);
  });
});

describe("waitingPhase", () => {
  it("names the three waits and nothing else", () => {
    expect(waitingPhase("connecting")).toBe("connecting");
    expect(waitingPhase("buffering")).toBe("buffering");
    expect(waitingPhase("reconnecting")).toBe("reconnecting");
    expect(waitingPhase("playing")).toBeNull();
    expect(waitingPhase("paused")).toBeNull();
  });
});

describe("showsScrubber", () => {
  it("needs a seekable item with a known length", () => {
    expect(showsScrubber(streamNowFixture({ seekable: true, live: false }), 2900)).toBe(true);
    expect(showsScrubber(streamNowFixture({ seekable: false, live: false }), 2900)).toBe(false);
    expect(showsScrubber(streamNowFixture({ seekable: true, live: false }), 0)).toBe(false);
    expect(showsScrubber(streamNowFixture({ seekable: false, live: true }), 0)).toBe(false);
  });

  it("follows seekable and length, never live", () => {
    expect(showsScrubber(streamNowFixture({ seekable: true, live: true }), 120)).toBe(true);
    expect(hasKnownLength(0)).toBe(false);
    expect(hasKnownLength(1)).toBe(true);
  });
});

describe("streamLines", () => {
  it("leads with the now line and puts the title beneath it", () => {
    expect(streamLines(streamNowFixture({ now: "Marlo Fenn - Slow Harbor", title: "Lowlight Jazz" }))).toEqual({
      first: "Marlo Fenn - Slow Harbor",
      second: "Lowlight Jazz",
    });
  });

  it("leads with the title over the artist when there is no now line", () => {
    expect(streamLines(streamNowFixture({ now: null, title: "Glass Orchard", artist: "Mira Okonkwo" }))).toEqual({
      first: "Glass Orchard",
      second: "Mira Okonkwo",
    });
  });

  it("leaves the second line empty when the plugin gives no artist", () => {
    expect(streamLines(streamNowFixture({ now: null, artist: null })).second).toBeNull();
  });
});

describe("stream strings", () => {
  const keys = ["streamingFrom", "listened", "paused", "connecting", "buffering", "reconnecting", "noSkip"] as const;

  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("exist in %s", (_name, dict) => {
    for (const key of keys) expect(dict.player.stream[key], key).toBeTruthy();
    expect(Object.keys(dict.player.stream).sort()).toEqual([...keys].sort());
  });

  it("carry no Live label in any locale", () => {
    for (const dict of [en, fr]) {
      expect(Object.keys(dict.player.stream).some((k) => /live/i.test(k))).toBe(false);
      expect(Object.values(dict.player.stream).some((v) => /\blive\b/i.test(v))).toBe(false);
    }
  });

  it("keep the interpolation slots in both locales", () => {
    for (const dict of [en, fr]) {
      expect(dict.player.stream.listened).toContain("{time}");
      expect(dict.player.stream.noSkip).toContain("{name}");
    }
  });
});

describe("resolveStream", () => {
  it("is null with no seat, whatever the hub holds", () => {
    expect(resolveStream(false, streamNowFixture(), -41)).toBeNull();
  });

  it("is the hub's state once it has arrived", () => {
    const now = streamNowFixture();
    expect(resolveStream(true, now, -41)).toBe(now);
  });

  it("is a connecting placeholder with empty lines while the seat has no hub state yet", () => {
    const stream = resolveStream(true, null, -41);
    expect(stream?.state).toBe("connecting");
    expect(stream?.item).toBe(-41);
    expect(stream?.title).toBe("");
    expect(stream?.plugin_name).toBe("");
    expect(streamLines(stream!)).toEqual({ first: "", second: null });
    expect(skipAllowed(stream, "next")).toBe(false);
  });
});

describe("skipAllowed", () => {
  it("allows every skip with no stream", () => {
    expect(skipAllowed(null, "next")).toBe(true);
    expect(skipAllowed(null, "prev")).toBe(true);
  });

  it("follows the plugin's accepted directions", () => {
    const stream = streamNowFixture({ skip: { next: true, prev: false } });
    expect(skipAllowed(stream, "next")).toBe(true);
    expect(skipAllowed(stream, "prev")).toBe(false);
  });
});
