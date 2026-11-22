import { describe, expect, it, vi } from "vitest";
import { createShownReporter, hostOf, shownHosts } from "./shownHosts";

const A = `pv-${"a".repeat(32)}.invalid`;
const B = `pv-${"b".repeat(32)}.invalid`;

const frame = (url: string | null, visible = true) => ({ visible: () => visible, url: () => url });

describe("hostOf", () => {
  it("takes the visualizer host of a frame URL and nothing else", () => {
    expect(hostOf(`https://${A}/vis/rings.html`)).toBe(A);
    expect(hostOf(`http://${A}/`)).toBe(A);
    expect(hostOf("https://pv-1.invalid/")).toBeNull();
    expect(hostOf(`https://pf-${"a".repeat(32)}.invalid/`)).toBeNull();
    expect(hostOf(`https://${A.toUpperCase()}.example/`)).toBeNull();
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("shownHosts", () => {
  it("is the sorted union of the visible frames' hosts", () => {
    const hosts = shownHosts([frame(`https://${B}/x`), frame(`https://${A}/y`), frame(`https://${B}/z`)]);
    expect(hosts).toEqual([A, B]);
  });

  it("leaves out hidden frames and frames with no known URL", () => {
    expect(shownHosts([frame(`https://${A}/`, false), frame(null)])).toEqual([]);
  });
});

describe("shown reporter", () => {
  it("samples only on a change and beats while frames are mounted", () => {
    const frames = [frame(`https://${A}/`)];
    const report = vi.fn();
    const reporter = createShownReporter({ handles: () => frames, report });
    reporter.sample();
    reporter.sample();
    expect(report).toHaveBeenCalledTimes(1);
    reporter.beat();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith([A]);
    frames.length = 0;
    reporter.beat();
    reporter.beat();
    expect(report).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenLastCalledWith([]);
  });
});
