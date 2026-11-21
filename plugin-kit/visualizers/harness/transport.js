/*
 * The host end of one mount's MessagePort, as Plisto runs it. Ticks go out through the protocol's credit
 * window (at most two in flight). While the slot is not visible nothing is sent and ticks fold into one held
 * tick, so the first tick after it returns carries the summed `dt` and `nBeats`. The stats say what the
 * readout shows: ticks sent and acked, the step cost of the latest ack, and the ticks folded away.
 */

// -- Local Imports --
import { createTickSender, foldTick, readFrameMessage } from "../lib/protocol.js";

/**
 * `port` is a MessagePort (or anything with postMessage, close and onmessage). `isVisible` says whether the
 * slot may be ticked. `onFrameMessage(message, nowMs)` hears every well-formed frame message; an ack arrives
 * after its credit is returned.
 */
export function createTransport({ port, isVisible, now = () => performance.now(), onFrameMessage }) {
  let disposed = false;
  let pending = null;
  let sent = 0;
  let acked = 0;
  let withheld = 0;
  let lastAckMs = null;

  const sender = createTickSender((tick) => {
    sent += 1;
    port.postMessage({ type: "tick", ...tick });
  });

  port.onmessage = (event) => {
    const message = readFrameMessage(event.data);
    if (!message || disposed) return;
    if (message.type === "ack") {
      acked += 1;
      lastAckMs = message.ms;
      sender.ack(message.seq);
    }
    onFrameMessage?.(message, now());
  };

  return {
    /** Takes one display frame's tick: sends it, folds it into the credit window, or withholds it. */
    offer(tick) {
      if (disposed) return;
      if (!isVisible()) {
        withheld += 1;
        pending = pending ? foldTick(pending, tick) : tick;
        return;
      }
      const next = pending ? foldTick(pending, tick) : tick;
      pending = null;
      sender.offer(next);
    },
    /** Posts any other host message: an update, a still request, the meter switch. */
    post(message) {
      if (!disposed) port.postMessage(message);
    },
    stats: () => ({ sent, acked, outstanding: sender.outstanding(), withheld, lastAckMs }),
    dispose() {
      if (disposed) return;
      port.postMessage({ type: "dispose" });
      disposed = true;
      port.onmessage = null;
      port.close();
    },
  };
}
