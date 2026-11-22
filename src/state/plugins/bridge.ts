/*
 * The wire protocol between the main window and a plugin frame, as pure code: the message types, the
 * frame map that is the only source of a plugin id, the router that decides what a received message
 * means, and the builders for every message the host sends. Nothing here touches the DOM, a timer or
 * IPC; the host shim feeds it events and carries out the actions it returns.
 */

// -- Type Imports --
import type { PluginApiError, PluginApiErrorCode, PluginCallReply } from "../../types";

/** The protocol number every message carries in `plisto`. */
export const PROTOCOL = 1;

/** The longest `args` string accepted, in UTF-16 code units. */
export const ARGS_MAX_CHARS = 262144;

/** The most calls of one frame that may await an answer at once. */
export const MAX_PENDING_PER_FRAME = 32;

/** The largest request body accepted, in bytes. */
export const BODY_MAX_BYTES = 1048576;

/** The only method that takes a body. */
export const FETCH_METHOD = "net.fetch";

/** The longest method name accepted. */
const METHOD_MAX_CHARS = 64;

/** A method name: two to four lowercase dotted segments. */
export const METHOD_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

/** The origin of every sandboxed frame. */
const FRAME_ORIGIN = "null";

/** The `app.info` result a frame receives at init. */
export interface AppInfo {
  api_version: number;
  plisto_version: string;
  plugin_id: string;
  plugin_version: string;
  locale: string;
  theme: "light" | "dark";
  app_mode: "player" | "organizer" | "both";
  tier: "ui" | "native";
  granted: string[];
}

export type ApiErrorShape = PluginApiError;

/** The only two messages a frame may send. `body` is moved with the call and only `net.fetch` takes one. */
export type FrameToHost =
  | { plisto: 1; type: "plisto:call"; id: number; method: string; args: string; body?: ArrayBuffer }
  | { plisto: 1; type: "plisto:pong"; seq: number };

/** One event of a streamed response, for the page that reads it. `seq` counts chunks from 1. */
export type StreamDelivery =
  | { stream: string; kind: "chunk"; seq: number; data: ArrayBuffer }
  | { stream: string; kind: "end" }
  | { stream: string; kind: "error"; code: string; reason: string | null };

/** One event of an open socket, for the page that holds it. */
export type SocketDelivery =
  | { socket: string; kind: "text"; data: string }
  | { socket: string; kind: "binary"; data: ArrayBuffer }
  | { socket: string; kind: "close"; code: number; reason: string; clean: boolean };

/**
 * Every message the host sends a frame. `plisto:plugin-event` carries a native plugin's page event and
 * the owner-only stream channel; `plisto:event` carries the app event topics a frame subscribed to. Both
 * exist in this direction only: the router never accepts either from a frame. `plisto:channel` is a
 * relayed channel message; `from` names the sending visualizer kind when a page receives it.
 */
export type HostToFrame =
  | ({ plisto: 1; type: "plisto:stream" } & StreamDelivery)
  | ({ plisto: 1; type: "plisto:socket" } & SocketDelivery)
  | {
      plisto: 1;
      type: "plisto:init";
      info: AppInfo;
      methods: string[];
      page_open: boolean;
      route: string | null;
    }
  | { plisto: 1; type: "plisto:result"; id: number; ok: true; result: unknown }
  | { plisto: 1; type: "plisto:result"; id: number; ok: false; error: ApiErrorShape }
  | { plisto: 1; type: "plisto:ping"; seq: number }
  | { plisto: 1; type: "plisto:visibility"; page_open: boolean }
  | { plisto: 1; type: "plisto:theme"; theme: "light" | "dark" }
  | { plisto: 1; type: "plisto:sidebar"; item_id: string; value: boolean | null; gesture: string }
  | { plisto: 1; type: "plisto:route"; route: string | null }
  | { plisto: 1; type: "plisto:plugin-event"; topic: string; data: unknown }
  | { plisto: 1; type: "plisto:event"; topic: string; data: unknown }
  | { plisto: 1; type: "plisto:channel"; data: unknown; from?: { kind: string } };

/**
 * What a frame is for. Page and background frames are both `page`. A visualizer frame is mapped so its
 * calls find their plugin, but it is never a delivery target and never counts for the plugin's session.
 */
export type FrameRole = "page" | "visualizer";

/** One mounted frame as the host tracks it. */
export interface FrameRecord<S> {
  mountKey: string;
  pluginId: string;
  source: S;
  /** Absent reads as a page frame. */
  role?: FrameRole;
  /** How many times the frame's document has finished loading. */
  loads: number;
  /** Calls forwarded and not yet answered. */
  pending: number;
  /** Set once the frame is unmounted or navigated away; a dead record takes no more messages. */
  dead: boolean;
}

/**
 * The frames the host knows, keyed by the window each one posts from. This is the only way a message
 * gets a plugin id: the source of a message event cannot be chosen or faked by the frame.
 */
export class FrameMap<S> {
  private readonly bySource = new Map<S, FrameRecord<S>>();
  private readonly byMountKey = new Map<string, FrameRecord<S>>();

  attach(source: S, rec: FrameRecord<S>): void {
    this.bySource.set(source, rec);
    this.byMountKey.set(rec.mountKey, rec);
  }

  get(source: S): FrameRecord<S> | undefined {
    return this.bySource.get(source);
  }

  byKey(mountKey: string): FrameRecord<S> | undefined {
    return this.byMountKey.get(mountKey);
  }

  /** Removes the record and marks it dead. Returns it, or undefined when the key is unknown. */
  detach(mountKey: string): FrameRecord<S> | undefined {
    const rec = this.byMountKey.get(mountKey);
    if (!rec) return undefined;
    rec.dead = true;
    this.byMountKey.delete(mountKey);
    this.bySource.delete(rec.source);
    return rec;
  }

  /** The records that still take messages. */
  live(): FrameRecord<S>[] {
    return [...this.byMountKey.values()].filter((rec) => !rec.dead);
  }

  /** The live records of one plugin, oldest attach first, so the last is the newest. */
  byPlugin(pluginId: string): FrameRecord<S>[] {
    return this.live().filter((rec) => rec.pluginId === pluginId);
  }

  /** The plugin's live records that may receive events, topics, streams and sockets, oldest first. */
  deliverable(pluginId: string): FrameRecord<S>[] {
    return this.pageFrames(pluginId);
  }

  /** The plugin's live records that keep its page session open. */
  sessionFrames(pluginId: string): FrameRecord<S>[] {
    return this.pageFrames(pluginId);
  }

  private pageFrames(pluginId: string): FrameRecord<S>[] {
    return this.byPlugin(pluginId).filter((rec) => rec.role !== "visualizer");
  }
}

/** What the host does with one received message event. */
export type Action<S> =
  | { kind: "drop" }
  | { kind: "reply"; rec: FrameRecord<S>; msg: HostToFrame }
  | { kind: "call"; rec: FrameRecord<S>; callId: number; method: string; args: string; body: ArrayBuffer | null }
  | { kind: "pong"; rec: FrameRecord<S>; seq: number };

const DROP = { kind: "drop" } as const;

/** The fields of a message event the router reads. */
export interface RouteInput<S> {
  origin: string;
  source: S | null;
  data: unknown;
}

const isId = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;

/**
 * Reads an own data property without running a getter or a proxy trap beyond the descriptor lookup.
 * An accessor, or an absent key, reads as undefined.
 */
function ownValue(obj: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc && "value" in desc ? desc.value : undefined;
}

/** Whether the value is an object whose prototype is exactly Object.prototype. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

// The intrinsic getter, taken once: it throws for anything but a real ArrayBuffer (a typed array, a Blob,
// a SharedArrayBuffer, a proxy, a look-alike with its own byteLength) and runs no code the value carries.
const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

/** The byte length of a real ArrayBuffer, or null for any other value. */
function arrayBufferLength(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !bufferByteLength) return null;
  try {
    return Reflect.apply(bufferByteLength, value, []) as number;
  } catch {
    return null;
  }
}

/** The `type` of the heartbeat answer. */
export const PONG_TYPE = "plisto:pong";

/** Whether a message is a plain object whose own `type` is exactly the pong's. Reads nothing else. */
export function isPongShaped(data: unknown): boolean {
  return isPlainObject(data) && ownValue(data, "type") === PONG_TYPE;
}

/** A shim-composed refusal for one call id. */
function refusal<S>(
  rec: FrameRecord<S>,
  callId: number,
  code: PluginApiErrorCode,
  message: string,
): Action<S> {
  return { kind: "reply", rec, msg: errorMsg(callId, code, message) };
}

/**
 * Decides what a received message means, applying the acceptance rules in order: origin, mapped live
 * source, protocol shape, per-type field checks, then the size and pending limits. Hostile input of any
 * kind drops or is answered; it never throws.
 */
export function route<S>(map: FrameMap<S>, event: RouteInput<S>): Action<S> {
  try {
    if (event.origin !== FRAME_ORIGIN) return DROP;
    if (event.source == null) return DROP;
    const rec = map.get(event.source);
    if (!rec || rec.dead) return DROP;

    const data = event.data;
    if (!isPlainObject(data)) return DROP;
    if (ownValue(data, "plisto") !== PROTOCOL) return DROP;
    const type = ownValue(data, "type");

    if (type === PONG_TYPE) {
      const seq = ownValue(data, "seq");
      return isId(seq) ? { kind: "pong", rec, seq } : DROP;
    }
    if (type !== "plisto:call") return DROP;

    const callId = ownValue(data, "id");
    if (!isId(callId)) return DROP;
    const method = ownValue(data, "method");
    const args = ownValue(data, "args");
    if (
      typeof method !== "string" ||
      method.length > METHOD_MAX_CHARS ||
      !METHOD_RE.test(method) ||
      typeof args !== "string"
    ) {
      return refusal(rec, callId, "invalid_args", "The call is malformed.");
    }
    // One descriptor read: an accessor body is refused without running it.
    const bodyDesc = Object.getOwnPropertyDescriptor(data, "body");
    let body: ArrayBuffer | null = null;
    let bodyBytes = 0;
    if (bodyDesc) {
      if (method !== FETCH_METHOD) {
        return refusal(rec, callId, "invalid_args", "Only net.fetch takes a body.");
      }
      const length = "value" in bodyDesc ? arrayBufferLength(bodyDesc.value) : null;
      if (length === null) return refusal(rec, callId, "invalid_args", "The body must be an ArrayBuffer.");
      body = bodyDesc.value as ArrayBuffer;
      bodyBytes = length;
    }
    if (args.length > ARGS_MAX_CHARS) {
      return refusal(rec, callId, "too_large", "The arguments are too large.");
    }
    if (bodyBytes > BODY_MAX_BYTES) {
      return refusal(rec, callId, "too_large", "The body is too large.");
    }
    if (rec.pending >= MAX_PENDING_PER_FRAME) {
      return refusal(rec, callId, "busy", "Too many calls are waiting; retry later.");
    }
    return { kind: "call", rec, callId, method, args, body };
  } catch {
    return DROP;
  }
}

// -- Message builders --

export function initMsg(
  info: AppInfo,
  methods: string[],
  pageOpen: boolean,
  routePath: string | null,
): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:init", info, methods, page_open: pageOpen, route: routePath };
}

/** The answer to one call: the reply's result, or its error. */
export function resultMsg(id: number, reply: PluginCallReply): HostToFrame {
  if (reply.ok) return { plisto: PROTOCOL, type: "plisto:result", id, ok: true, result: reply.result ?? null };
  const error = reply.error ?? { code: "unavailable", message: "The call could not reach Plisto." };
  return { plisto: PROTOCOL, type: "plisto:result", id, ok: false, error };
}

/** A failed answer the host composes itself. */
export function errorMsg(id: number, code: PluginApiErrorCode, message: string): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:result", id, ok: false, error: { code, message } };
}

export function pingMsg(seq: number): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:ping", seq };
}

export function visibilityMsg(pageOpen: boolean): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:visibility", page_open: pageOpen };
}

export function themeMsg(theme: "light" | "dark"): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:theme", theme };
}

/** A click Rust accepted on one of the plugin's items; `value` is null for an action. */
export function sidebarMsg(itemId: string, value: boolean | null, gesture: string): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:sidebar", item_id: itemId, value, gesture };
}

export function routeMsg(routePath: string | null): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:route", route: routePath };
}

/** A page event from the plugin's native process. */
export function pluginEventMsg(topic: string, data: unknown): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:plugin-event", topic, data };
}

/** An app event topic the frame subscribed to. */
export function eventMsg(topic: string, data: unknown): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:event", topic, data };
}

export function streamMsg(delivery: StreamDelivery): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:stream", ...delivery };
}

export function socketMsg(delivery: SocketDelivery): HostToFrame {
  return { plisto: PROTOCOL, type: "plisto:socket", ...delivery };
}

/** A channel message relayed from another frame of the same plugin. */
export function channelMsg(data: unknown, from?: { kind: string }): HostToFrame {
  return from
    ? { plisto: PROTOCOL, type: "plisto:channel", data, from }
    : { plisto: PROTOCOL, type: "plisto:channel", data };
}
