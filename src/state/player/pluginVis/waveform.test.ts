import { describe, expect, it, vi } from "vitest";
import { createWaveHub } from "./waveform";

function setup() {
  const setEmit = vi.fn((_on: boolean) => Promise.resolve());
  let handler: ((w: number[]) => void) | null = null;
  const stop = vi.fn();
  const follow = vi.fn((h: (w: number[]) => void) => {
    handler = h;
    return stop;
  });
  return { hub: createWaveHub({ setEmit, follow }), setEmit, stop, push: (w: number[]) => handler?.(w) };
}

describe("createWaveHub", () => {
  it("turns the emit on with the first holder and off after the last", () => {
    const s = setup();
    const a = s.hub.acquire();
    const b = s.hub.acquire();
    expect(s.setEmit.mock.calls).toEqual([[true]]);
    a();
    expect(s.setEmit).toHaveBeenCalledTimes(1);
    b();
    expect(s.setEmit.mock.calls).toEqual([[true], [false]]);
    expect(s.stop).toHaveBeenCalledTimes(1);
  });

  it("releases once however often it is called", () => {
    const s = setup();
    const a = s.hub.acquire();
    const b = s.hub.acquire();
    a();
    a();
    expect(s.hub.holders()).toBe(1);
    b();
    expect(s.hub.holders()).toBe(0);
  });

  it("holds the latest window as floats and drops it with the emit", () => {
    const s = setup();
    expect(s.hub.latest()).toBeNull();
    const release = s.hub.acquire();
    s.push([0.5, -0.5]);
    expect(Array.from(s.hub.latest() as Float32Array)).toEqual([0.5, -0.5]);
    release();
    expect(s.hub.latest()).toBeNull();
  });
});
