// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createTopicRouter } from "./topicRouter";

// -- Type Imports --
import type { PluginCallReply } from "../../types";

const ok = (topics: string[]): PluginCallReply => ({ ok: true, result: { topics, current: {} } });
const denied: PluginCallReply = { ok: false, error: { code: "denied", message: "no" } };
const args = (...topics: string[]) => JSON.stringify({ topics });

describe("createTopicRouter", () => {
  it("sends only accepted topics and drops the rest", () => {
    const r = createTopicRouter();
    r.settle(r.begin(args("theme")), ok(["theme"]));
    expect(r.offer("theme", 1)).toBe("send");
    expect(r.offer("locale", 1)).toBe("drop");
  });

  it("drops the stream topic outright, even while subscribing to it", () => {
    const r = createTopicRouter();
    const seq = r.begin(args("stream"));
    expect(r.offer("stream", 1)).toBe("drop");
    r.settle(seq, ok(["stream"]));
    expect(r.offer("stream", 1)).toBe("drop");
  });

  it("holds the latest event per topic in flight and releases the accepted ones", () => {
    const r = createTopicRouter();
    const seq = r.begin(args("theme", "locale"));
    expect(r.offer("theme", "a")).toBe("held");
    expect(r.offer("theme", "b")).toBe("held");
    expect(r.offer("locale", "fr")).toBe("held");
    expect(r.settle(seq, ok(["theme"]))).toEqual([{ topic: "theme", data: "b" }]);
    expect(r.offer("locale", "fr")).toBe("drop");
  });

  it("discards the hold on a refused reply and keeps the old set", () => {
    const r = createTopicRouter();
    r.settle(r.begin(args("theme")), ok(["theme"]));
    const seq = r.begin(args("locale"));
    expect(r.offer("locale", 1)).toBe("held");
    expect(r.settle(seq, denied)).toEqual([]);
    expect(r.offer("theme", 1)).toBe("send");
    expect(r.offer("locale", 1)).toBe("drop");
  });

  it("ignores an older reply's set", () => {
    const r = createTopicRouter();
    const older = r.begin(args("theme"));
    const newer = r.begin(args("locale"));
    r.settle(newer, ok(["locale"]));
    r.settle(older, ok(["theme"]));
    expect(r.offer("theme", 1)).toBe("drop");
    expect(r.offer("locale", 1)).toBe("send");
  });

  it("clears the set on a malformed ok reply", () => {
    const r = createTopicRouter();
    r.settle(r.begin(args("theme")), ok(["theme"]));
    r.settle(r.begin(args("theme")), { ok: true, result: { topics: [1] } });
    expect(r.offer("theme", 1)).toBe("drop");
  });

  it("holds nothing for unparsable subscribe args", () => {
    const r = createTopicRouter();
    r.begin("not json");
    expect(r.offer("theme", 1)).toBe("drop");
  });

  it("drops a held event once no subscribe in flight asks for its topic", () => {
    const r = createTopicRouter();
    const s1 = r.begin(args("queue"));
    const s2 = r.begin(args("now_playing"));
    r.settle(s2, ok(["now_playing"]));
    expect(r.offer("queue", { rev: 1 })).toBe("held");
    r.settle(s1, ok(["queue"]));
    const s3 = r.begin(args("queue"));
    expect(r.settle(s3, ok(["queue"]))).toEqual([]);
  });
});
