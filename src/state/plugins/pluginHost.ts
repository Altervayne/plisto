/*
 * The host shim: the main window's end of every plugin frame. One window `message` listener feeds the
 * router in bridge.ts and carries out its actions; calls go to Rust with the plugin id of the frame map
 * record, never one read from a message. Replies go only to the record that called, and only while it
 * is still mapped and alive. Every outside dependency is injected so the shim runs without a DOM.
 */

// -- State Imports --
import {
  FETCH_METHOD,
  FrameMap,
  isPongShaped,
  errorMsg,
  initMsg,
  pingMsg,
  eventMsg,
  pluginEventMsg,
  resultMsg,
  route,
  routeMsg,
  sidebarMsg,
  socketMsg,
  streamMsg,
  themeMsg,
  visibilityMsg,
} from "./bridge";
import { browserHostDeps } from "./hostBrowser";
import { FRAME_LIMIT, PONG_LIMIT, admit, defaultNow, newBudget } from "./frameBudget";
import { hostCall } from "./hostCall";
import { decodeFetchReply, encodeFetchRequest } from "./netFrame";
import { SUBSCRIBE_METHOD, createTopicRouter } from "./topicRouter";
import { screenCall } from "./visualizerAccess";

// -- Type Imports --
import type { FrameBudget } from "./frameBudget";
import type { TopicRouter } from "./topicRouter";
import type { AppInfo, FrameRecord, FrameRole, HostToFrame, SocketDelivery, StreamDelivery } from "./bridge";
import type {
  PluginCallReply,
  PluginSidebarDelivery,
  PluginStreamEvent,
} from "../../types";

export type FrameTheme = "light" | "dark";

/** The part of a frame's window the host uses. */
export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

/** The fields of a received message event the shim reads. */
export interface HostMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface HostDeps {
  /** Installs the message listener and returns its removal. */
  addListener: (onMessage: (event: HostMessage) => void) => () => void;
  invoke: (id: string, method: string, args: string) => Promise<PluginCallReply>;
  /** Sends one framed `net.fetch` request and resolves the framed reply. */
  fetch: (payload: Uint8Array) => Promise<ArrayBuffer>;
  /** The main window's effective theme. */
  theme: () => FrameTheme;
  subscribeTheme: (onChange: () => void) => () => void;
  /** Waits the given milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once a plugin's last mapped frame is detached. */
  frameGone?: (pluginId: string) => void;
  /** The clock for each frame's message budget, in milliseconds. */
  now?: () => number;
  /** The plugin's granted capabilities, read for a visualizer frame's calls. Absent reads as none. */
  granted?: (pluginId: string) => readonly string[];
}

export type LoadKind = "first" | "again";

type PongListener = (mountKey: string, seq: number) => void;

/** What the shim tracks per record beyond the frame map's own fields. */
interface FrameExtra {
  /** Call ids forwarded and not yet answered. */
  calls: Set<number>;
  pageOpen: boolean;
  init: "none" | "pending" | "done";
  /** The theme the frame last received, through init or a theme push. */
  theme: FrameTheme | null;
  /** The route the frame last received, or before init the one its init will carry. */
  route: string | null;
  /** The frame's own event subscription; a new frame starts with none. */
  router: TopicRouter;
  /** Settles when the frame's last forwarded subscribe has its answer; null when none is in flight. */
  subscribing: Promise<void> | null;
  /** What the frame may still post; spent by every message it sends, valid or not. */
  budget: FrameBudget;
  /** The frame's pong allowance, spent by nothing else. */
  pongBudget: FrameBudget;
}

const UNREACHABLE: PluginCallReply = {
  ok: false,
  error: { code: "unavailable", message: "The call could not reach Plisto." },
};

interface Host {
  attach: (mountKey: string, pluginId: string, source: FrameWindow, role: FrameRole) => void;
  detach: (mountKey: string) => void;
  loaded: (mountKey: string) => LoadKind;
  isLoaded: (mountKey: string) => boolean;
  sendInit: (mountKey: string, routePath: string | null) => Promise<boolean>;
  sendPing: (mountKey: string, seq: number) => boolean;
  sendVisibility: (mountKey: string, pageOpen: boolean) => void;
  sendRoute: (mountKey: string, routePath: string | null) => void;
  sendSidebar: (pluginId: string, delivery: PluginSidebarDelivery) => boolean;
  sendPluginEvent: (pluginId: string, topic: string, data: unknown) => boolean;
  sendTopicEvent: (pluginId: string, topic: string, data: unknown, seq: unknown) => boolean;
  sendStream: (pluginId: string, delivery: StreamDelivery) => boolean;
  sendSocket: (pluginId: string, delivery: SocketDelivery) => boolean;
  hasLiveFrame: (pluginId: string) => boolean;
  stop: () => void;
}

// Pong listeners outlive any one host, so a subscriber need not start after the host does.
const pongs = new Set<PongListener>();

function createHost(deps: HostDeps): Host {
  const map = new FrameMap<FrameWindow>();
  const now = deps.now ?? defaultNow;
  const extras = new WeakMap<FrameRecord<FrameWindow>, FrameExtra>();

  const isLive = (rec: FrameRecord<FrameWindow>) => !rec.dead && map.byKey(rec.mountKey) === rec;

  // A transferred buffer is detached once posted: nothing reads it after this call.
  const post = (rec: FrameRecord<FrameWindow>, msg: HostToFrame, transfer?: ArrayBuffer[]) => {
    if (!isLive(rec)) return;
    try {
      if (transfer) rec.source.postMessage(msg, "*", transfer);
      else rec.source.postMessage(msg, "*");
    } catch {
      // A window torn down mid-post has nothing left to tell.
    }
  };

  const entry = (mountKey: string) => {
    const rec = map.byKey(mountKey);
    const extra = rec && extras.get(rec);
    return rec && extra && !rec.dead ? { rec, extra } : null;
  };

  const pushTheme = (rec: FrameRecord<FrameWindow>, extra: FrameExtra) => {
    const theme = deps.theme();
    if (extra.init !== "done" || extra.theme === theme) return;
    extra.theme = theme;
    post(rec, themeMsg(theme));
  };

  /** Runs `net.fetch` over the raw command. Any failure, a malformed reply included, reads as unreachable. */
  const fetchCall = async (pluginId: string, args: string, body: ArrayBuffer | null) => {
    try {
      const raw = await deps.fetch(encodeFetchRequest(pluginId, args, body));
      return decodeFetchReply(raw) ?? { reply: UNREACHABLE, body: null };
    } catch {
      return { reply: UNREACHABLE, body: null };
    }
  };

  const forward = async (
    rec: FrameRecord<FrameWindow>,
    extra: FrameExtra,
    callId: number,
    method: string,
    args: string,
    body: ArrayBuffer | null,
  ) => {
    // The router cannot see which ids are still waiting, so a repeated one is refused here.
    if (extra.calls.has(callId)) {
      post(rec, errorMsg(callId, "invalid_args", "The call id is already waiting for an answer."));
      return;
    }
    extra.calls.add(callId);
    rec.pending += 1;
    const subscribing = method === SUBSCRIBE_METHOD;
    if (subscribing) extra.router.begin();
    // A frame's subscribes reach Rust one at a time, so Rust applies them in the order they were issued.
    const turn = subscribing ? extra.subscribing : null;
    let release = () => {};
    const mine = subscribing ? new Promise<void>((resolve) => (release = () => resolve())) : null;
    if (mine) extra.subscribing = mine;
    let reply: PluginCallReply;
    let transfer: ArrayBuffer[] | undefined;
    if (method === FETCH_METHOD) {
      const fetched = await fetchCall(rec.pluginId, args, body);
      reply = fetched.reply;
      transfer = fetched.body ? [fetched.body] : undefined;
    } else {
      try {
        if (turn) await turn;
        reply = await deps.invoke(rec.pluginId, method, args);
      } catch {
        reply = UNREACHABLE;
      }
    }
    release();
    if (mine && extra.subscribing === mine) extra.subscribing = null;
    rec.pending -= 1;
    extra.calls.delete(callId);
    // Applied before the reply is posted; events held meanwhile follow the reply.
    const settled = subscribing
      ? extra.router.settle(reply ?? UNREACHABLE)
      : { reply: reply ?? UNREACHABLE, held: [] };
    post(rec, resultMsg(callId, settled.reply), transfer);
    for (const event of settled.held) post(rec, eventMsg(event.topic, event.data));
  };

  /** One of the host's own calls at init, retried only while the record is live. */
  const initCall = (rec: FrameRecord<FrameWindow>, method: string) =>
    hostCall(deps, rec.pluginId, method, () => isLive(rec));

  const onMessage = (event: HostMessage) => {
    // Spent before any parsing: a flood costs the host one map lookup per message, and an over-budget
    // message gets no reply, so the page cannot make the host post back either.
    const source = event.source as FrameWindow | null;
    const known = source == null ? undefined : map.get(source);
    const owned = known && extras.get(known);
    if (owned && !admit(isPongShaped(event.data) ? owned.pongBudget : owned.budget, now())) return;
    const action = screenCall(
      route(map, { origin: event.origin, source: event.source as FrameWindow | null, data: event.data }),
      deps.granted ?? (() => []),
    );
    if (action.kind === "reply") post(action.rec, action.msg);
    else if (action.kind === "pong") pongs.forEach((listener) => listener(action.rec.mountKey, action.seq));
    else if (action.kind === "call") {
      const extra = extras.get(action.rec);
      if (extra) void forward(action.rec, extra, action.callId, action.method, action.args, action.body);
    }
  };

  const unmap = (mountKey: string) => {
    const rec = map.detach(mountKey);
    if (rec) extras.get(rec)?.calls.clear();
    return rec;
  };

  // Reported only when no other page or background frame of the plugin is left, so a remount does not
  // release what the newer frame opened. A visualizer frame never ends the session.
  const endIfLast = (rec: FrameRecord<FrameWindow> | undefined) => {
    const ends = rec && rec.role !== "visualizer" && map.sessionFrames(rec.pluginId).length === 0;
    if (ends) deps.frameGone?.(rec.pluginId);
  };
  const detach = (mountKey: string) => endIfLast(unmap(mountKey));

  /** The plugin's newest deliverable live record whose init is done. Never a record of another plugin. */
  const initialised = (pluginId: string) => {
    const recs = map.deliverable(pluginId);
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      const rec = recs[i];
      if (rec.pluginId === pluginId && extras.get(rec)?.init === "done" && isLive(rec)) return rec;
    }
    return null;
  };

  const removeListener = deps.addListener(onMessage);
  const unsubscribeTheme = deps.subscribeTheme(() => {
    for (const rec of map.live()) {
      const extra = extras.get(rec);
      if (extra) pushTheme(rec, extra);
    }
  });

  return {
    attach(mountKey, pluginId, source, role) {
      const displaced = [unmap(mountKey)];
      const holder = map.get(source);
      if (holder) displaced.push(unmap(holder.mountKey));
      const rec: FrameRecord<FrameWindow> = { mountKey, pluginId, source, role, loads: 0, pending: 0, dead: false };
      map.attach(source, rec);
      extras.set(rec, {
        calls: new Set(),
        pageOpen: false,
        init: "none",
        theme: null,
        route: null,
        router: createTopicRouter(),
        subscribing: null,
        budget: newBudget(now(), FRAME_LIMIT),
        pongBudget: newBudget(now(), PONG_LIMIT),
      });
      // Checked once the new record is mapped, so a page remount of the same plugin keeps the session.
      displaced.forEach(endIfLast);
    },

    detach,

    loaded(mountKey) {
      const found = entry(mountKey);
      if (!found) return "again";
      const { rec, extra } = found;
      rec.loads += 1;
      if (rec.loads === 1) return "first";
      // A second load means the frame left its document: nothing more reaches it or comes from it.
      rec.dead = true;
      extra.calls.clear();
      return "again";
    },

    isLoaded(mountKey) {
      const found = entry(mountKey);
      return found != null && found.rec.loads === 1;
    },

    async sendInit(mountKey, routePath) {
      const found = entry(mountKey);
      if (!found || found.rec.loads !== 1 || found.extra.init !== "none") return false;
      const { rec, extra } = found;
      extra.init = "pending";
      extra.route = routePath;
      const [info, methods] = await Promise.all([initCall(rec, "app.info"), initCall(rec, "app.methods")]);
      const names = (methods as { methods?: unknown } | null)?.methods;
      if (!info || !Array.isArray(names) || !isLive(rec)) return false;
      const appInfo = info as AppInfo;
      // Read after the await, so a visibility or route change during init is carried by the init itself.
      post(rec, initMsg(appInfo, names as string[], extra.pageOpen, extra.route));
      extra.init = "done";
      extra.theme = appInfo.theme;
      pushTheme(rec, extra);
      return true;
    },

    sendPing(mountKey, seq) {
      const found = entry(mountKey);
      if (!found || found.rec.loads !== 1) return false;
      post(found.rec, pingMsg(seq));
      return true;
    },

    sendVisibility(mountKey, pageOpen) {
      const found = entry(mountKey);
      if (!found || found.extra.pageOpen === pageOpen) return;
      found.extra.pageOpen = pageOpen;
      if (found.extra.init === "done") post(found.rec, visibilityMsg(pageOpen));
    },

    sendRoute(mountKey, routePath) {
      const found = entry(mountKey);
      if (!found) return;
      const { rec, extra } = found;
      if (extra.init !== "done") {
        extra.route = routePath;
        return;
      }
      if (!extra.pageOpen || extra.route === routePath) return;
      extra.route = routePath;
      post(rec, routeMsg(routePath));
    },

    sendSidebar(pluginId, delivery) {
      const rec = initialised(pluginId);
      if (!rec) return false;
      post(rec, sidebarMsg(delivery.item_id, delivery.value, delivery.gesture));
      return true;
    },

    sendPluginEvent(pluginId, topic, data) {
      const rec = initialised(pluginId);
      if (!rec) return false;
      post(rec, pluginEventMsg(topic, data));
      return true;
    },

    sendTopicEvent(pluginId, topic, data, seq) {
      const rec = initialised(pluginId);
      const router = rec && extras.get(rec)?.router;
      const offer = router ? router.offer(topic, data, seq) : "drop";
      if (rec && offer === "send") post(rec, eventMsg(topic, data));
      return offer !== "drop";
    },

    sendStream(pluginId, delivery) {
      const rec = initialised(pluginId);
      if (!rec) return false;
      post(rec, streamMsg(delivery), delivery.kind === "chunk" ? [delivery.data] : undefined);
      return true;
    },

    sendSocket(pluginId, delivery) {
      const rec = initialised(pluginId);
      if (!rec) return false;
      post(rec, socketMsg(delivery), delivery.kind === "binary" ? [delivery.data] : undefined);
      return true;
    },

    hasLiveFrame(pluginId) {
      return initialised(pluginId) != null;
    },

    stop() {
      removeListener();
      unsubscribeTheme();
      for (const rec of map.live()) detach(rec.mountKey);
    },
  };
}

let active: Host | null = null;

/** Starts the shim and returns its teardown. A second start replaces the first, so one listener exists. */
export function startPluginHost(deps: HostDeps = browserHostDeps()): () => void {
  active?.stop();
  const host = createHost(deps);
  active = host;
  return () => {
    host.stop();
    if (active === host) active = null;
  };
}

/** Maps a frame's window to its plugin. Call once the iframe has a window and before its first load. */
export function attachFrame(mountKey: string, pluginId: string, source: FrameWindow, role: FrameRole = "page"): void {
  active?.attach(mountKey, pluginId, source, role);
}

/**
 * Forgets a frame. Answers still in flight for it are dropped. When it was the plugin's last page or
 * background frame, Rust hears that it detached or crashed, which ends the plugin's open toasts and prompts.
 */
export function detachFrame(mountKey: string): void {
  active?.detach(mountKey);
}

/**
 * Records a `load` of the frame's document. The first is the frame starting; any later one means it
 * navigated, so the record is dead before this returns. An unknown or dead frame also reads "again".
 */
export function frameLoaded(mountKey: string): LoadKind {
  return active ? active.loaded(mountKey) : "again";
}

/** Whether the frame is mapped, alive and has loaded its document once. */
export function isFrameLoaded(mountKey: string): boolean {
  return active?.isLoaded(mountKey) ?? false;
}

/**
 * Posts `plisto:init` after the host's own `app.info` and `app.methods` calls. Runs once per frame, only
 * after its first load. Resolves false when nothing was posted.
 */
export function sendInit(mountKey: string, routePath: string | null = null): Promise<boolean> {
  return active ? active.sendInit(mountKey, routePath) : Promise.resolve(false);
}

/** Posts a ping to a loaded, live frame. Returns whether it was posted. */
export function sendPing(mountKey: string, seq: number): boolean {
  return active?.sendPing(mountKey, seq) ?? false;
}

/**
 * Sets whether the frame's page is shown. Posted only on a change and only after init; before init the
 * value is held and carried by `plisto:init`.
 */
export function sendVisibility(mountKey: string, pageOpen: boolean): void {
  active?.sendVisibility(mountKey, pageOpen);
}

/**
 * Sets the route of the frame's shown page. Posted only after init, only while the page is open and only
 * when it differs from the last route the frame received; before init it is carried by `plisto:init`.
 */
export function sendRoute(mountKey: string, routePath: string | null): void {
  active?.sendRoute(mountKey, routePath);
}

/**
 * Posts an accepted sidebar click to the plugin's newest live, initialised frame. Returns false when
 * there is none; nothing is held for a later frame.
 */
export function sendSidebar(pluginId: string, delivery: PluginSidebarDelivery): boolean {
  return active?.sendSidebar(pluginId, delivery) ?? false;
}

/**
 * Posts a native plugin's page event to the plugin's newest live, initialised frame. Returns false when
 * there is none; the event is dropped, never held for a later frame.
 */
export function sendPluginEvent(pluginId: string, topic: string, data: unknown): boolean {
  return active?.sendPluginEvent(pluginId, topic, data) ?? false;
}

/**
 * Posts an app event topic to the plugin's newest live, initialised frame, and only when that frame's own
 * subscribe reply accepted the topic. An event for a topic a subscribe in flight asked for is held until
 * its reply and posted after it. Returns false when the event is dropped.
 */
export function sendTopicEvent(pluginId: string, topic: string, data: unknown, seq: unknown): boolean {
  return active?.sendTopicEvent(pluginId, topic, data, seq) ?? false;
}

/** The topic a plugin's playback-stream events arrive on in its frame. */
export const PLAYBACK_STREAM_TOPIC = "stream";

/**
 * Posts a playback-stream event to the owning plugin's newest live, initialised frame and to no other.
 * Returns false when it has none; the event is dropped, never held for a later frame.
 */
export function sendPlaybackStreamEvent(pluginId: string, event: PluginStreamEvent): boolean {
  return sendPluginEvent(pluginId, PLAYBACK_STREAM_TOPIC, event);
}

/**
 * Posts a streamed-response event to the plugin's newest live, initialised frame, moving a chunk's
 * buffer with it. Returns false when there is none; the event is dropped.
 */
export function sendStream(pluginId: string, delivery: StreamDelivery): boolean {
  return active?.sendStream(pluginId, delivery) ?? false;
}

/**
 * Posts a socket event to the plugin's newest live, initialised frame, moving a binary message's buffer
 * with it. Returns false when there is none; the event is dropped.
 */
export function sendSocket(pluginId: string, delivery: SocketDelivery): boolean {
  return active?.sendSocket(pluginId, delivery) ?? false;
}

/** Whether the plugin has a live frame whose init is done. */
export function hasLiveFrame(pluginId: string): boolean {
  return active?.hasLiveFrame(pluginId) ?? false;
}

/** Subscribes to accepted pongs. Returns the unsubscribe. */
export function onPong(listener: PongListener): () => void {
  pongs.add(listener);
  return () => {
    pongs.delete(listener);
  };
}
