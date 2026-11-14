/*
 * The raw framing of `plugin_fetch`, as pure code. Both directions are a little-endian u32 length, that
 * many bytes of UTF-8 JSON, then raw body bytes, so a body crosses IPC as binary instead of base64 in
 * JSON. The Rust command parses the same layout; anything that does not frame exactly reads as malformed.
 */

// -- Type Imports --
import type { PluginCallReply } from "../../types";

/** The bytes of the length prefix. */
const PREFIX_BYTES = 4;

/** A decoded reply. `body` is the buffered response body, also set on `reply.result.body`. */
export interface FetchReply {
  reply: PluginCallReply;
  body: ArrayBuffer | null;
}

/** Frames one `net.fetch` request: `{"id", "args"}` then the body bytes. */
export function encodeFetchRequest(pluginId: string, args: string, body: ArrayBuffer | null): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ id: pluginId, args }));
  const bytes = body ? new Uint8Array(body) : new Uint8Array(0);
  const out = new Uint8Array(PREFIX_BYTES + meta.length + bytes.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, PREFIX_BYTES);
  out.set(bytes, PREFIX_BYTES + meta.length);
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a `plugin_fetch` reply. Trailing bytes are the body of a buffered success and nothing else: a
 * refusal or a streamed head that carries any is malformed, and so is a refusal without an error code.
 * Returns null for anything malformed.
 */
export function decodeFetchReply(raw: unknown): FetchReply | null {
  if (!(raw instanceof ArrayBuffer) || raw.byteLength < PREFIX_BYTES) return null;
  const metaLength = new DataView(raw).getUint32(0, true);
  const bodyStart = PREFIX_BYTES + metaLength;
  if (bodyStart > raw.byteLength) return null;

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(raw, PREFIX_BYTES, metaLength));
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") return null;
  const trailing = raw.byteLength - bodyStart;

  if (!parsed.ok) {
    const error = parsed.error;
    if (trailing !== 0 || !isRecord(error) || typeof error.code !== "string") return null;
    return { reply: parsed as unknown as PluginCallReply, body: null };
  }
  const result = parsed.result;
  if (!isRecord(result)) return null;
  if ("stream" in result) {
    return trailing === 0 ? { reply: { ok: true, result }, body: null } : null;
  }
  const body = raw.slice(bodyStart);
  return { reply: { ok: true, result: { ...result, body } }, body };
}

/** Decodes standard base64 to a fresh ArrayBuffer. Null when the text is not valid base64. */
export function base64ToBuffer(text: string): ArrayBuffer | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
