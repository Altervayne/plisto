// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createTopicRouter } from "./topicRouter";

// -- Type Imports --
import type { PluginCallReply } from "../../types";

const ok = (topics: string[], mark = 0): PluginCallReply => ({ ok: true, result: { topics, current: {}, mark } });
const denied: PluginCallReply = { ok: false, error: { code: "denied", message: "no" } };

/** Runs one subscribe to its reply with nothing in between. */
function subscribe(r: ReturnType<typeof createTopicRouter>, reply: PluginCallReply) {
  r.begin();
  return r.settle(reply);
}

describe("createTopicRouter", () => {
  it("sends only accepted topics and drops the rest", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme"]));
    expect(r.offer("theme", 1, 1)).toBe("send");
    expect(r.offer("locale", 1, 2)).toBe("drop");
  });

  it("drops the stream topic outright, even while subscribing to it", () => {
    const r = createTopicRouter();
    r.begin();
    expect(r.offer("stream", 1, 1)).toBe("drop");
    r.settle(ok(["stream"]));
    expect(r.offer("stream", 1, 2)).toBe("drop");
  });

  it("drops an event whose seq is missing or not a number", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme"]));
    expect(r.offer("theme", 1, undefined)).toBe("drop");
    expect(r.offer("theme", 1, "5")).toBe("drop");
    expect(r.offer("theme", 1, Number.NaN)).toBe("drop");
  });

  it("holds events of a first subscribe and releases only those above the mark", () => {
    const r = createTopicRouter();
    r.begin();
    expect(r.offer("theme", "a", 3)).toBe("held");
    expect(r.offer("theme", "b", 7)).toBe("held");
    expect(r.offer("locale", "fr", 9)).toBe("held");
    expect(r.offer("queue", "q", 4)).toBe("held");
    const out = r.settle(ok(["theme", "queue"], 5));
    expect(out.held).toEqual([{ topic: "theme", data: "b" }]);
    expect(r.offer("locale", "fr", 10)).toBe("drop");
  });

  it("drops an event at or under the mark, before or after the reply", () => {
    const r = createTopicRouter();
    r.begin();
    r.offer("theme", "early", 4);
    expect(r.settle(ok(["theme"], 4)).held).toEqual([]);
    expect(r.offer("theme", "late", 4)).toBe("drop");
    expect(r.offer("theme", "older", 2)).toBe("drop");
    expect(r.offer("theme", "newer", 5)).toBe("send");
  });

  it("never lets a re-subscribe snapshot land after a newer event of a kept topic", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme"], 0));
    r.begin();
    expect(r.offer("theme", "newer", 6)).toBe("held");
    expect(r.offer("theme", "older", 3)).toBe("held");
    expect(r.settle(ok(["theme"], 4)).held).toEqual([{ topic: "theme", data: "newer" }]);
  });

  it("keeps the latest held event per topic by seq, not arrival", () => {
    const r = createTopicRouter();
    r.begin();
    r.offer("theme", "b", 8);
    r.offer("theme", "a", 6);
    expect(r.settle(ok(["theme"], 0)).held).toEqual([{ topic: "theme", data: "b" }]);
  });

  it("never delivers an event from before the second reply's mark for a topic dropped and added again", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme"], 0));
    subscribe(r, ok([], 5));
    r.begin();
    expect(r.offer("theme", "stale", 5)).toBe("drop");
    expect(r.offer("theme", "mid", 8)).toBe("held");
    expect(r.settle(ok(["theme"], 10)).held).toEqual([]);
    expect(r.offer("theme", "fresh", 11)).toBe("send");
  });

  it("discards the held event of a topic a re-subscribe drops", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme", "locale"], 0));
    r.begin();
    r.offer("locale", "fr", 3);
    expect(r.settle(ok(["theme"], 0)).held).toEqual([]);
    expect(r.offer("locale", "fr", 4)).toBe("drop");
  });

  it("keeps the first set in force when the second of two subscribes is refused", () => {
    const r = createTopicRouter();
    r.begin();
    r.begin();
    r.offer("theme", "t", 7);
    r.offer("locale", "l", 8);
    expect(r.settle(ok(["theme"], 5)).held).toEqual([]);
    expect(r.settle(denied).held).toEqual([{ topic: "theme", data: "t" }]);
    expect(r.offer("theme", 1, 9)).toBe("send");
    expect(r.offer("locale", 1, 10)).toBe("drop");
  });

  it("keeps the old set and mark on a refusal and delivers held events of kept topics", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme"], 3));
    r.begin();
    r.offer("theme", "kept", 5);
    r.offer("locale", "new", 6);
    expect(r.settle(denied).held).toEqual([{ topic: "theme", data: "kept" }]);
    expect(r.offer("theme", 1, 3)).toBe("drop");
  });

  it("holds while any subscribe is unsettled and releases in seq order at the last", () => {
    const r = createTopicRouter();
    r.begin();
    r.begin();
    r.offer("locale", "l", 9);
    r.offer("theme", "t", 6);
    r.offer("queue", "q", 7);
    expect(r.settle(ok(["theme", "locale", "queue"], 0)).held).toEqual([]);
    expect(r.offer("theme", "t2", 12)).toBe("held");
    expect(r.settle(ok(["theme", "locale", "queue"], 0)).held).toEqual([
      { topic: "queue", data: "q" },
      { topic: "locale", data: "l" },
      { topic: "theme", data: "t2" },
    ]);
  });

  it("strips the mark from the reply and leaves the rest", () => {
    const r = createTopicRouter();
    r.begin();
    expect(r.settle(ok(["theme"], 4)).reply).toEqual({ ok: true, result: { topics: ["theme"], current: {} } });
    expect(subscribe(r, denied).reply).toEqual(denied);
  });

  it("fails closed on an ok reply of another shape", () => {
    const r = createTopicRouter();
    subscribe(r, ok(["theme"]));
    subscribe(r, { ok: true, result: { topics: [1], mark: 0 } });
    expect(r.offer("theme", 1, 1)).toBe("drop");
    subscribe(r, ok(["theme"]));
    subscribe(r, { ok: true, result: { topics: ["theme"] } });
    expect(r.offer("theme", 1, 2)).toBe("drop");
  });
});
