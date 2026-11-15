/*
 * One frame's event subscription, React-free. The set of topics a frame may hear comes only from its own
 * accepted `events.subscribe` reply, and only from the latest subscribe it issued, so a slow older reply
 * cannot widen or shrink it. An event for a topic a subscribe in flight asked for is held (latest per
 * topic) until that reply decides whether the frame accepted it; a refused reply discards the hold.
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
  /** Registers a subscribe the frame is issuing; returns its sequence number. */
  begin: (args: string) => number;
  /** Applies a settled subscribe reply; returns the held events to post after the reply itself. */
  settle: (seq: number, reply: PluginCallReply) => TopicDelivery[];
  /** Decides what happens to an event for the frame. */
  offer: (topic: string, data: unknown) => Offer;
}

/** The topic names an `events.subscribe` args string asks for; empty when it does not parse. */
function requestedTopics(args: string): string[] {
  try {
    const topics = (JSON.parse(args) as { topics?: unknown } | null)?.topics;
    return Array.isArray(topics) ? topics.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** The accepted topic names of an ok reply, or null when its result has another shape. */
function acceptedTopics(reply: PluginCallReply): string[] | null {
  if (!reply?.ok) return null;
  const topics = (reply.result as { topics?: unknown } | null)?.topics;
  if (!Array.isArray(topics) || !topics.every((t) => typeof t === "string")) return null;
  return topics as string[];
}

export function createTopicRouter(): TopicRouter {
  let topics = new Set<string>();
  let issued = 0;
  const inflight = new Map<number, Set<string>>();
  const held = new Map<string, unknown>();

  const wanted = (topic: string) => {
    for (const asked of inflight.values()) if (asked.has(topic)) return true;
    return false;
  };

  // A held event is only worth keeping while a subscribe in flight still asks for its topic.
  const prune = () => {
    for (const topic of [...held.keys()]) if (!wanted(topic)) held.delete(topic);
  };

  return {
    begin(args) {
      prune();
      issued += 1;
      inflight.set(issued, new Set(requestedTopics(args)));
      return issued;
    },

    settle(seq, reply) {
      inflight.delete(seq);
      // An older reply still answers its caller but never changes the set.
      if (seq !== issued) {
        prune();
        return [];
      }
      const next = acceptedTopics(reply);
      const heldNow = [...held];
      held.clear();
      if (!next) {
        // A well-formed refusal keeps the previous set; an ok reply of another shape fails closed.
        if (reply?.ok) topics = new Set();
        return [];
      }
      topics = new Set(next);
      return heldNow
        .filter(([topic]) => topics.has(topic))
        .map(([topic, data]) => ({ topic, data }));
    },

    offer(topic, data) {
      if (topic === STREAM_TOPIC) return "drop";
      if (topics.has(topic)) return "send";
      if (wanted(topic)) {
        held.set(topic, data);
        return "held";
      }
      return "drop";
    },
  };
}
