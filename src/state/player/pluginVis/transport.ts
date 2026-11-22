/*
 * The host end of one mount's MessagePort. Ticks go out through the protocol's credit window; while the
 * slot is not visible nothing is sent and the ticks fold into one held tick, so the first tick after the
 * slot returns carries the summed `dt` and `nBeats`. Silence while hidden is never a hang, so the stats
 * say whether the slot was visible and whether ticks were sent over an interval.
 */

// -- Local Imports --
import {
  createTickSender,
  foldTick,
  readFrameMessage,
  type FrameMessage,
  type HostMessage,
  type Tick,
} from "../../../visRuntime/protocol";

/** The slice of a MessagePort the host uses. */
export interface HostPort {
  postMessage: (message: HostMessage) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface TransportOptions {
  port: HostPort;
  isVisible: () => boolean;
  // Milliseconds on any monotonic clock; stamps the stats.
  now?: () => number;
  // Every well-formed frame message except acks, which the transport consumes itself.
  onFrameMessage?: (message: FrameMessage) => void;
  // Every tick as it goes out to the frame: folded ticks arrive folded, withheld ones not at all.
  onSend?: (tick: Tick) => void;
}

/** What a net reads to tell a hung frame from a quiet one. */
export interface TransportStats {
  visible: boolean;
  // When the slot last became visible, or null while it is not.
  visibleSince: number | null;
  sent: number;
  acked: number;
  outstanding: number;
  lastSentAt: number | null;
  lastAckAt: number | null;
  // The cost the frame reported with its latest ack.
  lastAckMs: number | null;
  // Ticks folded away while the slot was hidden.
  withheld: number;
}

export interface Transport {
  // Takes one display frame's tick: sends it, folds it into the credit window, or withholds it while hidden.
  offer: (tick: Tick) => void;
  // Posts any other host message: an update, a still request, the meter switch.
  post: (message: HostMessage) => void;
  stats: () => TransportStats;
  // Forgets the ticks in flight and any held tick, for a frame that stopped consuming.
  reset: () => void;
  dispose: () => void;
}

export function createTransport(options: TransportOptions): Transport {
  const { port, isVisible, onFrameMessage, onSend } = options;
  const now = options.now ?? (() => performance.now());
  let disposed = false;
  let pending: Tick | null = null;
  let visibleSince: number | null = null;
  let sent = 0;
  let acked = 0;
  let withheld = 0;
  let lastSentAt: number | null = null;
  let lastAckAt: number | null = null;
  let lastAckMs: number | null = null;

  const sender = createTickSender((tick) => {
    sent += 1;
    lastSentAt = now();
    port.postMessage({ type: "tick", ...tick });
    onSend?.(tick);
  });

  port.onmessage = (event) => {
    const message = readFrameMessage(event.data);
    if (!message || disposed) return;
    if (message.type === "ack") {
      acked += 1;
      lastAckAt = now();
      lastAckMs = message.ms;
      sender.ack(message.seq);
      return;
    }
    onFrameMessage?.(message);
  };

  return {
    offer(tick) {
      if (disposed) return;
      if (!isVisible()) {
        visibleSince = null;
        withheld += 1;
        pending = pending ? foldTick(pending, tick) : tick;
        return;
      }
      if (visibleSince === null) visibleSince = now();
      const next = pending ? foldTick(pending, tick) : tick;
      pending = null;
      sender.offer(next);
    },
    post(message) {
      if (!disposed) port.postMessage(message);
    },
    stats: () => ({
      visible: visibleSince !== null,
      visibleSince,
      sent,
      acked,
      outstanding: sender.outstanding(),
      lastSentAt,
      lastAckAt,
      lastAckMs,
      withheld,
    }),
    reset() {
      sender.reset();
      pending = null;
    },
    dispose() {
      if (disposed) return;
      port.postMessage({ type: "dispose" });
      disposed = true;
      port.onmessage = null;
      port.close();
    },
  };
}
