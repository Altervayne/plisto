// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { EVENT_TOPIC, createTopicEventSync } from "./usePluginEvents";

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
  const stop = createTopicEventSync({ listen, send });
  return { send, off, emit: (payload: unknown) => handler({ payload }), name: () => name, stop };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createTopicEventSync", () => {
  it("posts each event to its plugin", async () => {
    const { send, emit, name } = setup();
    await flush();
    expect(name()).toBe(EVENT_TOPIC);
    emit({ id: "dev.tandem", topic: "theme", data: { theme: "dark" }, seq: 7 });
    expect(send).toHaveBeenCalledWith("dev.tandem", "theme", { theme: "dark" }, 7);
  });

  it("drops a malformed payload", async () => {
    const { send, emit } = setup();
    await flush();
    emit(null);
    emit("theme");
    emit({ topic: "theme", data: 1 });
    emit({ id: "dev.tandem", data: 1 });
    emit({ id: 1, topic: "theme", seq: 1 });
    emit({ id: "dev.tandem", topic: "theme", data: 1 });
    emit({ id: "dev.tandem", topic: "theme", data: 1, seq: "3" });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops posting and unlistens on teardown", async () => {
    const { send, off, emit, stop } = setup();
    await flush();
    stop();
    expect(off).toHaveBeenCalledTimes(1);
    emit({ id: "dev.tandem", topic: "theme", data: 1, seq: 1 });
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
    createTopicEventSync({ listen, send });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listen).toHaveBeenCalledTimes(2);
    handler({ payload: { id: "a", topic: "theme", data: 1, seq: 1 } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("removes a listener that resolves after teardown", async () => {
    const off = vi.fn();
    let resolve: (fn: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((r) => (resolve = r)));
    const stop = createTopicEventSync({ listen, send: vi.fn(() => true) });
    stop();
    resolve(off);
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
