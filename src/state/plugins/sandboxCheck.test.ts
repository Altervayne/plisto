// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { runSandboxCheck } from "./sandboxCheck";

// -- Type Imports --
import type { SandboxDeps } from "./sandboxCheck";

type PeerCtor = new (config: RTCConfiguration) => RTCPeerConnection;

interface FakePeer {
  config: RTCConfiguration;
  closed: boolean;
}

let peers: FakePeer[] = [];

// What the fake listeners have received so far. A packet is only counted once a peer sends it, so a
// close issued before the legs ran, or before a late packet landed, reads a smaller count.
const received = { udp: 0, tcp: 0 };
let leak: "none" | "udp" | "tcp" | "late-udp" = "none";

class GoodPeer {
  iceGatheringState = "new";
  private listeners: (() => void)[] = [];
  fake: FakePeer;
  constructor(config: RTCConfiguration) {
    this.fake = { config, closed: false };
    peers.push(this.fake);
  }
  createDataChannel() {}
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "" });
  }
  setLocalDescription() {
    const url = String(this.fake.config.iceServers?.[0].urls);
    if (leak === "udp" && url.startsWith("stun:")) received.udp++;
    if (leak === "tcp" && url.includes("transport=tcp")) received.tcp++;
    if (leak === "late-udp" && url.startsWith("stun:")) setTimeout(() => received.udp++, 20);
    queueMicrotask(() => {
      this.iceGatheringState = "complete";
      this.listeners.forEach((fn) => fn());
    });
    return Promise.resolve();
  }
  addEventListener(_: string, fn: () => void) {
    this.listeners.push(fn);
  }
  close() {
    this.fake.closed = true;
  }
}

class StuckPeer extends GoodPeer {
  setLocalDescription() {
    return Promise.resolve();
  }
}

class ThrowingPeer {
  constructor() {
    throw new Error("blocked");
  }
}

const open = vi.fn();
const close = vi.fn();

const deps = (over: Partial<SandboxDeps> = {}): SandboxDeps => ({
  open,
  close,
  peer: () => GoodPeer as unknown as PeerCtor,
  retry: (fn) => fn(),
  gatherMs: 50,
  settleMs: 1,
  ...over,
});

beforeEach(() => {
  peers = [];
  received.udp = 0;
  received.tcp = 0;
  leak = "none";
  open.mockReset().mockResolvedValue({ token: "t", udp_port: 4000, tcp_port: 4001 });
  close.mockReset().mockImplementation(() => Promise.resolve({ ...received }));
});

afterEach(() => vi.useRealTimers());

describe("runSandboxCheck", () => {
  it("passes when nothing reached the listeners, and aims three legs at them", async () => {
    const result = await runSandboxCheck(deps());
    expect(result).toEqual({ outcome: "passed", udp: 0, tcp: 0 });
    expect(peers.map((p) => p.config.iceServers?.[0].urls)).toEqual([
      "stun:127.0.0.1:4000",
      "turn:127.0.0.1:4000?transport=udp",
      "turn:127.0.0.1:4001?transport=tcp",
    ]);
    expect(peers.every((p) => p.closed)).toBe(true);
    expect(close).toHaveBeenCalledWith("t");
  });

  it("is leaking when a datagram arrived", async () => {
    leak = "udp";
    expect(await runSandboxCheck(deps())).toEqual({ outcome: "leaking", udp: 1, tcp: 0 });
  });

  it("is leaking when a TCP connection arrived", async () => {
    leak = "tcp";
    expect(await runSandboxCheck(deps())).toEqual({ outcome: "leaking", udp: 0, tcp: 1 });
  });

  it("counts a packet that lands only during the settle wait", async () => {
    leak = "late-udp";
    expect((await runSandboxCheck(deps({ settleMs: 100 }))).outcome).toBe("leaking");
  });

  it("is unverified when the listeners cannot be opened", async () => {
    open.mockRejectedValue(new Error("not the main window"));
    expect((await runSandboxCheck(deps())).outcome).toBe("unverified");
    expect(close).not.toHaveBeenCalled();
  });

  it("is unverified when the count cannot be read", async () => {
    close.mockRejectedValue(new Error("gone"));
    expect((await runSandboxCheck(deps())).outcome).toBe("unverified");
  });

  it("passes at 0/0 and still closes the listeners when the constructor throws", async () => {
    const result = await runSandboxCheck(deps({ peer: () => ThrowingPeer as unknown as PeerCtor }));
    expect(result).toEqual({ outcome: "passed", udp: 0, tcp: 0 });
    expect(close).toHaveBeenCalledWith("t");
  });

  it("passes and closes the listeners when WebRTC is absent", async () => {
    expect((await runSandboxCheck(deps({ peer: () => null }))).outcome).toBe("passed");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("gives up on a leg that never finishes gathering, closes it and leaves no timer", async () => {
    vi.useFakeTimers();
    const run = runSandboxCheck(
      deps({ peer: () => StuckPeer as unknown as PeerCtor, gatherMs: 2000, settleMs: 300 }),
    );
    await vi.advanceTimersByTimeAsync(2400);
    expect((await run).outcome).toBe("passed");
    expect(peers.every((p) => p.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
