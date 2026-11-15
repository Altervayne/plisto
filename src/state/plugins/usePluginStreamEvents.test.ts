// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { EVENT_PLAYBACK_STREAM, createStreamEventSync } from "./usePluginStreamEvents";

type Handler = (event: { payload: unknown }) => void;

function setup(send = vi.fn(() => true)) {
  const off = vi.fn();
  let handler: Handler = () => {};
  let name = "";
  const listen = vi.fn((n: string, h: Handler) => {
    name = n;
    handler = h;
    return Promise.resolve(off);
  });
  const stop = createStreamEventSync({ listen, send });
  return { send, off, emit: (payload: unknown) => handler({ payload }), name: () => name, stop };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const EVENT = { item: -41, kind: "skip", direction: "next" } as const;

describe("createStreamEventSync", () => {
  it("posts each event to its owner", async () => {
    const { send, emit, name } = setup();
    await flush();
    expect(name()).toBe(EVENT_PLAYBACK_STREAM);
    emit({ id: "night-radio", event: EVENT });
    expect(send).toHaveBeenCalledWith("night-radio", EVENT);
  });

  it("drops a payload that is not an event", async () => {
    const { send, emit } = setup();
    await flush();
    emit(null);
    emit({ id: "night-radio" });
    emit({ id: 1, event: EVENT });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops posting and unlistens on teardown", async () => {
    const { send, off, emit, stop } = setup();
    await flush();
    stop();
    expect(off).toHaveBeenCalledTimes(1);
    emit({ id: "night-radio", event: EVENT });
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a rejected listen", async () => {
    const off = vi.fn();
    let handler: Handler = () => {};
    const listen = vi
      .fn<(n: string, h: Handler) => Promise<() => void>>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockImplementation((_n, h) => {
        handler = h;
        return Promise.resolve(off);
      });
    const send = vi.fn(() => true);
    createStreamEventSync({ listen, send });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listen).toHaveBeenCalledTimes(2);
    handler({ payload: { id: "night-radio", event: EVENT } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("removes a listener that resolves after teardown", async () => {
    const off = vi.fn();
    let resolve: (fn: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((r) => (resolve = r)));
    const stop = createStreamEventSync({ listen, send: vi.fn(() => true) });
    stop();
    resolve(off);
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
