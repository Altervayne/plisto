/*
 * One frame's event subscription, React-free. Events and subscribe replies travel on separate channels, so
 * order is decided by numbers, not arrival. Every event carries a `seq` that strictly rises with each event
 * Plisto produces (a frame sees gaps); an ok subscribe reply carries a `mark`, the `seq` of the last event
 * produced before the set was recorded. An event at or under the mark is never posted: Plisto re-reads every
 * state topic after each subscribe and sends what differs, above the mark. One above it is posted after the reply,
 * in `seq` order. The accepted set is that of the last ok reply, replies being applied in the order Plisto
 * answered; a refusal changes neither the set nor the mark. While a subscribe is unsettled, events are held (latest per
 * topic); once none is, held events above the mark whose topic is in the set are released and the rest are
 * discarded. The mark never reaches the frame.
 */

// -- Type Imports --
import type { PluginCallReply } from "../../types";

/** The method a frame subscribes to app event topics with. */
export const SUBSCRIBE_METHOD = "events.subscribe";

/** The topic of the owner-only stream channel, which never travels on this path. */
const STREAM_TOPIC = "stream";

/** An event ready to post to the frame. */
export interface TopicDelivery {
  topic: string;
  data: unknown;
}

/** What the router decided for an event offered to the frame. */
export type Offer = "send" | "held" | "drop";

export interface TopicRouter {
  /** Registers a subscribe the frame is forwarding. */
  begin: () => void;
  /** Applies a settled subscribe reply; returns the reply to post and the held events to post after it. */
  settle: (reply: PluginCallReply) => { reply: PluginCallReply; held: TopicDelivery[] };
  /** Decides what happens to an event for the frame. */
  offer: (topic: string, data: unknown, seq: unknown) => Offer;
}

/** The accepted topic names and mark of an ok reply, or null when its result has another shape. */
function accepted(reply: PluginCallReply): { topics: string[]; mark: number } | null {
  if (!reply?.ok) return null;
  const { topics, mark } = (reply.result ?? {}) as { topics?: unknown; mark?: unknown };
  if (!Array.isArray(topics) || !topics.every((t) => typeof t === "string")) return null;
  if (typeof mark !== "number" || !Number.isFinite(mark)) return null;
  return { topics: topics as string[], mark };
}

/** The reply without its `mark`. */
function withoutMark(reply: PluginCallReply): PluginCallReply {
  const result = reply?.ok ? reply.result : null;
  if (typeof result !== "object" || result === null || !("mark" in result)) return reply;
  const { mark: _mark, ...rest } = reply.result as Record<string, unknown>;
  return { ...reply, result: rest };
}

export function createTopicRouter(): TopicRouter {
  let topics = new Set<string>();
  let mark = 0;
  let unsettled = 0;
  const held = new Map<string, { seq: number; data: unknown }>();

  return {
    begin() {
      unsettled += 1;
    },

    settle(reply) {
      unsettled = Math.max(0, unsettled - 1);
      const next = accepted(reply);
      if (next) {
        topics = new Set(next.topics);
        mark = next.mark;
      } else if (reply?.ok) {
        // An ok reply of another shape fails closed; a well-formed refusal changes nothing.
        topics = new Set();
      }
      for (const [topic, entry] of [...held]) if (entry.seq <= mark) held.delete(topic);
      const out = withoutMark(reply);
      if (unsettled > 0) return { reply: out, held: [] };
      const release = [...held]
        .filter(([topic]) => topics.has(topic))
        .sort((a, b) => a[1].seq - b[1].seq)
        .map(([topic, entry]) => ({ topic, data: entry.data }));
      held.clear();
      return { reply: out, held: release };
    },

    offer(topic, data, seq) {
      if (topic === STREAM_TOPIC || typeof seq !== "number" || !Number.isFinite(seq) || seq <= mark) return "drop";
      if (unsettled > 0) {
        const prior = held.get(topic);
        if (!prior || prior.seq < seq) held.set(topic, { seq, data });
        return "held";
      }
      return topics.has(topic) ? "send" : "drop";
    },
  };
}
