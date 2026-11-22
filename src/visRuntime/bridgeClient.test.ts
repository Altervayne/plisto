import { describe, expect, it } from "vitest";

import { BRIDGE_PROTOCOL, createBridgeClient } from "./bridgeClient";
import { CHANNEL_MAX_BYTES, CHANNEL_METHOD, channelText } from "./protocol";

function setup() {
  const sent: Record<string, unknown>[] = [];
  const client = createBridgeClient((msg) => sent.push(msg));
  return { client, sent };
}

describe("the channel's send", () => {
  it("posts one channel call carrying the data as the call's JSON arguments", () => {
    const { client, sent } = setup();
    client.channel.send({ level: 3 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "plisto:call", method: CHANNEL_METHOD, plisto: BRIDGE_PROTOCOL });
    expect(JSON.parse(sent[0].args as string)).toEqual({ data: { level: 3 } });
  });

  it("throws a RangeError over the limit and a TypeError for data that cannot be serialized", () => {
    const { client, sent } = setup();
    expect(() => client.channel.send("x".repeat(CHANNEL_MAX_BYTES))).toThrow(RangeError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => client.channel.send(loop)).toThrow(TypeError);
    expect(() => client.channel.send(undefined)).toThrow(TypeError);
    expect(() => client.channel.send(() => 1)).toThrow(TypeError);
    expect(sent).toHaveLength(0);
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    const { client } = setup();
    const two = "\u00e9".repeat(CHANNEL_MAX_BYTES / 2 - 1);
    expect(() => client.channel.send(two)).not.toThrow();
    expect(() => client.channel.send("\u00e9".repeat(CHANNEL_MAX_BYTES / 2))).toThrow(RangeError);
  });

  it("accepts a message of exactly the limit", () => {
    expect(channelText("x".repeat(CHANNEL_MAX_BYTES - 2))).toHaveLength(CHANNEL_MAX_BYTES);
  });
});

describe("the channel's receive", () => {
  it("hands each listener the data, and stops after the unsubscribe", () => {
    const { client } = setup();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const off = client.channel.onMessage((d) => a.push(d));
    client.channel.onMessage((d) => b.push(d));
    expect(client.handle({ type: "plisto:channel", data: { n: 1 } })).toBe(true);
    off();
    client.handle({ type: "plisto:channel", data: { n: 2 } });
    expect(a).toEqual([{ n: 1 }]);
    expect(b).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("keeps delivering when a listener throws", () => {
    const { client } = setup();
    const got: unknown[] = [];
    client.channel.onMessage(() => {
      throw new Error("boom");
    });
    client.channel.onMessage((d) => got.push(d));
    client.handle({ type: "plisto:channel", data: 7 });
    expect(got).toEqual([7]);
  });
});
