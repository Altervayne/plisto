// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { added, announceAfterBlock, playsAfter, useQueueToast } from "./queueToast";

function Probe() {
  const { notice, visible } = useQueueToast();
  return <i>{`${notice.kind}:${visible}`}</i>;
}
const read = () => /<i>(.*)<\/i>/.exec(renderToStaticMarkup(<Probe />))?.[1];

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
});

describe("announceAfterBlock", () => {
  it("replaces the append tally when the tracks landed after a kept block", () => {
    added(2);
    expect(read()).toBe("added:true");
    announceAfterBlock({ afterBlock: true });
    expect(read()).toBe("playsAfterAlbum:true");
  });

  // The store raises the parked-track line first under a stream, then reports the block outcome. The
  // album line wins when the playing row is inside a kept block; otherwise the parked line stays.
  it("replaces the parked-track line under a stream when the tracks landed after a block", () => {
    playsAfter("Harbor Lights");
    expect(read()).toBe("playsAfter:true");
    announceAfterBlock({ afterBlock: true });
    expect(read()).toBe("playsAfterAlbum:true");
  });

  it("keeps the parked-track line under a stream when no block was involved", () => {
    playsAfter("Harbor Lights");
    announceAfterBlock({ afterBlock: false });
    expect(read()).toBe("playsAfter:true");
  });

  it("leaves the tally be when they landed elsewhere, or no outcome came back", () => {
    added(2);
    announceAfterBlock({ afterBlock: false });
    announceAfterBlock(undefined);
    expect(read()).toBe("added:true");
  });
});
