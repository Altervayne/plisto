// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { base64ToBuffer, decodeFetchReply, encodeFetchRequest } from "./netFrame";

/** Frames meta text and raw bytes, with a length prefix that may lie. */
function frame(meta: string, body: number[] = [], length?: number): ArrayBuffer {
  const json = new TextEncoder().encode(meta);
  const out = new Uint8Array(4 + json.length + body.length);
  new DataView(out.buffer).setUint32(0, length ?? json.length, true);
  out.set(json, 4);
  out.set(body, 4 + json.length);
  return out.buffer;
}

const HEAD = { status: 200, url: "https://a.example/x", redirected: false, headers: [["a", "b"]], set_cookies: [] };

describe("encodeFetchRequest", () => {
  it("writes the length, the id and args JSON, then the body", () => {
    const body = new Uint8Array([0, 255, 10]).buffer;
    const bytes = encodeFetchRequest("plug-a", '{"url":"https://a.example/\u00e9"}', body);
    const n = new DataView(bytes.buffer).getUint32(0, true);
    expect(bytes.length).toBe(4 + n + 3);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)))).toEqual({
      id: "plug-a",
      args: '{"url":"https://a.example/\u00e9"}',
    });
    expect([...bytes.subarray(4 + n)]).toEqual([0, 255, 10]);
    expect(body.byteLength).toBe(3);
  });

  it("writes no body bytes without a body", () => {
    const bytes = encodeFetchRequest("p", "{}", null);
    const n = new DataView(bytes.buffer).getUint32(0, true);
    expect(bytes.length).toBe(4 + n);
  });
});

describe("decodeFetchReply", () => {
  it("attaches the trailing bytes of a buffered success as the body", () => {
    const decoded = decodeFetchReply(frame(JSON.stringify({ ok: true, result: HEAD }), [104, 105]));
    expect(decoded).not.toBeNull();
    const result = decoded?.reply.result as { body: ArrayBuffer };
    expect(decoded?.reply).toMatchObject({ ok: true, result: HEAD });
    expect(result.body).toBe(decoded?.body);
    expect(new TextDecoder().decode(result.body)).toBe("hi");
  });

  it("gives a buffered success with no trailing bytes an empty body", () => {
    const decoded = decodeFetchReply(frame(JSON.stringify({ ok: true, result: { ...HEAD, status: 204 } })));
    expect(decoded?.body?.byteLength).toBe(0);
  });

  it("reads a streamed head and a refusal with no body", () => {
    const head = decodeFetchReply(frame(JSON.stringify({ ok: true, result: { ...HEAD, stream: "t1" } })));
    expect(head).toEqual({ reply: { ok: true, result: { ...HEAD, stream: "t1" } }, body: null });
    const none = decodeFetchReply(frame(JSON.stringify({ ok: true, result: { ...HEAD, stream: null } })));
    expect(none?.body).toBeNull();
    const error = { code: "denied", message: "no", reason: "blocked_address" };
    expect(decodeFetchReply(frame(JSON.stringify({ ok: false, error })))).toEqual({
      reply: { ok: false, error },
      body: null,
    });
  });

  it("returns null for truncated and overlong lengths", () => {
    const good = JSON.stringify({ ok: true, result: HEAD });
    expect(decodeFetchReply(new ArrayBuffer(0))).toBeNull();
    expect(decodeFetchReply(new Uint8Array([1, 0, 0]).buffer)).toBeNull();
    expect(decodeFetchReply(frame(good, [], good.length + 1))).toBeNull();
    expect(decodeFetchReply(frame(good, [], 0xffffffff))).toBeNull();
    // A short length cuts the JSON, which then fails to parse.
    expect(decodeFetchReply(frame(good, [], good.length - 1))).toBeNull();
  });

  it("returns null for a refusal without an error record carrying a string code", () => {
    const bad = [{ ok: false }, { ok: false, error: null }, { ok: false, error: "denied" }, { ok: false, error: { code: 5 } }, { ok: false, error: {} }];
    for (const meta of bad) expect(decodeFetchReply(frame(JSON.stringify(meta)))).toBeNull();
  });

  it("returns null for bytes after a refusal or a streamed head", () => {
    expect(decodeFetchReply(frame(JSON.stringify({ ok: false, error: { code: "busy", message: "x" } }), [1]))).toBeNull();
    expect(decodeFetchReply(frame(JSON.stringify({ ok: true, result: { ...HEAD, stream: "t1" } }), [1]))).toBeNull();
  });

  it("returns null for anything but a framed reply object", () => {
    const bad = ["", "null", "[]", '"x"', "{}", '{"ok":"yes"}', '{"ok":true}', '{"ok":true,"result":[1]}', "{"];
    for (const meta of bad) expect(decodeFetchReply(frame(meta))).toBeNull();
    const invalidUtf8 = new Uint8Array([2, 0, 0, 0, 0xc3, 0x28]).buffer;
    expect(decodeFetchReply(invalidUtf8)).toBeNull();
    expect(decodeFetchReply(new Uint8Array(8))).toBeNull();
    expect(decodeFetchReply(null)).toBeNull();
  });
});

describe("base64ToBuffer", () => {
  it("decodes to the exact bytes and refuses invalid text", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const decoded = base64ToBuffer(btoa(String.fromCharCode(...all)));
    expect(decoded && [...new Uint8Array(decoded)]).toEqual([...all]);
    expect(base64ToBuffer("")?.byteLength).toBe(0);
    expect(base64ToBuffer("@@@@")).toBeNull();
  });
});
