/*
 * The sandbox self-check runner. Rust opens loopback listeners; three WebRTC legs (STUN, TURN over UDP,
 * TURN over TCP) are aimed at them from this webview, and anything that arrives means the webview's
 * WebRTC guard is not holding. A leg whose constructor is missing or throws sends nothing, which is the
 * guard working, not a failure. The listeners are always closed.
 */

// -- IPC Imports --
import { sandboxCheckClose, sandboxCheckOpen } from "../../lib/ipc";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

// -- Type Imports --
import type { SandboxCheckCounts, SandboxCheckSinks } from "../../types";

/** What the check found. "unverified" means it could not run. */
export type SandboxOutcome = "passed" | "leaking" | "unverified";

/** The result of one run, with the datagram and connection counts that reached the listeners. */
export interface SandboxResult extends SandboxCheckCounts {
  outcome: SandboxOutcome;
}

type PeerCtor = new (config: RTCConfiguration) => RTCPeerConnection;

/** The pieces a run depends on, replaceable in tests. */
export interface SandboxDeps {
  open: () => Promise<SandboxCheckSinks>;
  close: (token: string) => Promise<SandboxCheckCounts>;
  /** The peer connection constructor, or null when the webview has no WebRTC. */
  peer: () => PeerCtor | null;
  retry: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The longest a leg waits for candidate gathering. */
  gatherMs: number;
  /** The wait after the legs, for late packets. */
  settleMs: number;
}

const DUMMY_USER = "plisto";
const DUMMY_SECRET = "plisto";

export const defaultDeps = (): SandboxDeps => ({
  open: sandboxCheckOpen,
  close: sandboxCheckClose,
  peer: () => (typeof RTCPeerConnection === "undefined" ? null : RTCPeerConnection),
  retry: (fn) => withRetry(fn),
  gatherMs: 2000,
  settleMs: 300,
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One connection toward `urls`: gathers candidates (or gives up after `gatherMs`), then closes. */
async function runLeg(Peer: PeerCtor, urls: string, gatherMs: number) {
  let connection: RTCPeerConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn = urls.startsWith("turn:");
    connection = new Peer({
      iceServers: [turn ? { urls, username: DUMMY_USER, credential: DUMMY_SECRET } : { urls }],
    });
    const pc = connection;
    pc.createDataChannel("probe");
    const gathered = new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") resolve();
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") resolve();
      });
      timer = setTimeout(resolve, gatherMs);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered;
  } catch {
    // A leg that cannot start sends nothing.
  } finally {
    clearTimeout(timer);
    try {
      connection?.close();
    } catch {
      // Already closed.
    }
  }
}

/** Runs the check once. Never rejects. */
export async function runSandboxCheck(deps: SandboxDeps = defaultDeps()): Promise<SandboxResult> {
  const unverified: SandboxResult = { outcome: "unverified", udp: 0, tcp: 0 };
  let sinks: SandboxCheckSinks;
  try {
    sinks = await deps.retry(deps.open);
  } catch {
    return unverified;
  }
  try {
    const Peer = deps.peer();
    if (Peer) {
      const legs = [
        `stun:127.0.0.1:${sinks.udp_port}`,
        `turn:127.0.0.1:${sinks.udp_port}?transport=udp`,
        `turn:127.0.0.1:${sinks.tcp_port}?transport=tcp`,
      ];
      await Promise.all(legs.map((urls) => runLeg(Peer, urls, deps.gatherMs)));
    }
    await wait(deps.settleMs);
  } catch {
    // The counts below decide the outcome.
  }
  try {
    const counts = await deps.close(sinks.token);
    return { outcome: counts.udp > 0 || counts.tcp > 0 ? "leaking" : "passed", ...counts };
  } catch {
    return unverified;
  }
}
