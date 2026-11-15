// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { EVENT_PAGE, createPageEventSync } from "./usePluginPageEvents";

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
  const stop = createPageEventSync({ listen, send });
  return { send, off, emit: (payload: unknown) => handler({ payload }), name: () => name, stop };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createPageEventSync", () => {
  it("posts each event to its own plugin", async () => {
    const { send, emit, name } = setup();
    await flush();
    expect(name()).toBe(EVENT_PAGE);
    emit({ id: "tap", topic: "level", data: { db: -3 } });
    expect(send).toHaveBeenCalledWith("tap", "level", { db: -3 });
  });

  it("drops a payload that is not an event", async () => {
    const { send, emit } = setup();
    await flush();
    emit(null);
    emit("tap");
    emit({ id: 1, topic: "level" });
    emit({ id: "tap" });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops posting and unlistens on teardown", async () => {
    const { send, off, emit, stop } = setup();
    await flush();
    stop();
    expect(off).toHaveBeenCalledTimes(1);
    emit({ id: "tap", topic: "level", data: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("unlistens at once when torn down before the subscription resolves", async () => {
    const { off, stop } = setup();
    stop();
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
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
    createPageEventSync({ listen, send });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listen).toHaveBeenCalledTimes(2);
    handler({ payload: { id: "tap", topic: "level", data: 1 } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("removes a listener that resolves after teardown", async () => {
    const off = vi.fn();
    let resolve: (fn: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((r) => (resolve = r)));
    const stop = createPageEventSync({ listen, send: vi.fn(() => true) });
    stop();
    resolve(off);
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
