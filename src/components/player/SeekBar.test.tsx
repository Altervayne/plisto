// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SeekBar } from "./SeekBar";

const render = (props: Partial<Parameters<typeof SeekBar>[0]> = {}) =>
  renderToStaticMarkup(<SeekBar position={2538} duration={0} onSeek={() => {}} {...props} />);

describe("SeekBar for a library track", () => {
  it("keeps the scrubber and both times", () => {
    const html = render({ position: 72, duration: 266 });
    expect(html).toContain('role="slider"');
    expect(html).toContain("1:12");
    expect(html).toContain("4:26");
  });
});

describe("SeekBar listened-only", () => {
  it("has no scrubber and shows the listened time in its place", () => {
    const html = render({ listenedOnly: true });
    expect(html).not.toContain('role="slider"');
    expect(html).toContain("42:18 listened");
  });

  it("shows the waiting word instead of the listened time", () => {
    const html = render({ listenedOnly: true, note: "Reconnecting" });
    expect(html).toContain("Reconnecting");
    expect(html).not.toContain(" listened");
  });

  it("puts no animation class on the word", () => {
    const html = render({ listenedOnly: true, note: "Buffering" });
    expect(html).not.toMatch(/class="[^"]*(anim|pulse|blink|fade|spin|shimmer|flash)/i);
  });
});

describe("SeekBar with a waiting seek", () => {
  it("shows the word between the two times and keeps the scrubber", () => {
    const html = render({ position: 1798, duration: 2900, note: "Buffering" });
    expect(html).toContain('role="slider"');
    const left = html.indexOf("29:58");
    const mid = html.indexOf("Buffering");
    const right = html.indexOf("48:20");
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(mid);
    expect(mid).toBeLessThan(right);
  });

  it("shows no middle word without a note", () => {
    expect(render({ position: 1, duration: 100 })).not.toContain("Buffering");
  });
});
