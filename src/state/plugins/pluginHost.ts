/*
 * The host shim: the main window's end of every plugin frame. One window `message` listener feeds the
 * router in bridge.ts and carries out its actions; calls go to Rust with the plugin id of the frame map
 * record, never one read from a message. Replies go only to the record that called, and only while it
 * is still mapped and alive. Every outside dependency is injected so the shim runs without a DOM.
 */

// -- State Imports --
import {
  FrameMap,
  errorMsg,
  initMsg,
  pingMsg,
  pluginEventMsg,
  resultMsg,
  route,
  routeMsg,
  sidebarMsg,
  themeMsg,
  visibilityMsg,
} from "./bridge";
import { useFrameHealthStore } from "./frameHealth";
import { useSidebarState } from "./sidebarState";

// -- IPC Imports --
import { pluginCall, pluginFrameEvent } from "../../lib/ipc";

// -- Utils Imports --
import { isDarkTheme, subscribeTheme } from "../../theme";

// -- Type Imports --
import type { AppInfo, FrameRecord, HostToFrame } from "./bridge";
import type {
  PluginCallReply,
  PluginFrameCrashReason,
  PluginFrameEventKind,
  PluginSidebarDelivery,
} from "../../types";

export type FrameTheme = "light" | "dark";

/** The part of a frame's window the host uses. */
export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
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
  /** The main window's effective theme. */
  theme: () => FrameTheme;
  subscribeTheme: (onChange: () => void) => () => void;
  /** Waits the given milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once a plugin's last mapped frame is detached. */
  frameGone?: (pluginId: string) => void;
}

const HOST_CALL_ATTEMPTS = 5;
const RETRY_DEFAULT_MS = 500;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 2000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
}

const UNREACHABLE: PluginCallReply = {
  ok: false,
  error: { code: "unavailable", message: "The call could not reach Plisto." },
};

interface Host {
  attach: (mountKey: string, pluginId: string, source: FrameWindow) => void;
  detach: (mountKey: string) => void;
  loaded: (mountKey: string) => LoadKind;
  isLoaded: (mountKey: string) => boolean;
  sendInit: (mountKey: string, routePath: string | null) => Promise<boolean>;
  sendPing: (mountKey: string, seq: number) => boolean;
  sendVisibility: (mountKey: string, pageOpen: boolean) => void;
  sendRoute: (mountKey: string, routePath: string | null) => void;
  sendSidebar: (pluginId: string, delivery: PluginSidebarDelivery) => boolean;
  sendPluginEvent: (pluginId: string, topic: string, data: unknown) => boolean;
  hasLiveFrame: (pluginId: string) => boolean;
  stop: () => void;
}

// Pong listeners outlive any one host, so a subscriber need not start after the host does.
const pongs = new Set<PongListener>();

function createHost(deps: HostDeps): Host {
  const map = new FrameMap<FrameWindow>();
  const extras = new WeakMap<FrameRecord<FrameWindow>, FrameExtra>();

  const isLive = (rec: FrameRecord<FrameWindow>) => !rec.dead && map.byKey(rec.mountKey) === rec;

  const post = (rec: FrameRecord<FrameWindow>, msg: HostToFrame) => {
    if (!isLive(rec)) return;
    try {
      rec.source.postMessage(msg, "*");
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

  const forward = async (rec: FrameRecord<FrameWindow>, extra: FrameExtra, callId: number, method: string, args: string) => {
    // The router cannot see which ids are still waiting, so a repeated one is refused here.
    if (extra.calls.has(callId)) {
      post(rec, errorMsg(callId, "invalid_args", "The call id is already waiting for an answer."));
      return;
    }
    extra.calls.add(callId);
    rec.pending += 1;
    let reply: PluginCallReply;
    try {
      reply = await deps.invoke(rec.pluginId, method, args);
    } catch {
      reply = UNREACHABLE;
    }
    rec.pending -= 1;
    extra.calls.delete(callId);
    post(rec, resultMsg(callId, reply ?? UNREACHABLE));
  };

  /**
   * One of the host's own calls at init. Null on any refusal or failure. A rate limit is retried after
   * the reply's hint, up to a fixed number of attempts, and only while the record is live.
   */
  const hostCall = async (rec: FrameRecord<FrameWindow>, method: string): Promise<unknown> => {
    const sleep = deps.sleep ?? defaultSleep;
    for (let attempt = 1; attempt <= HOST_CALL_ATTEMPTS; attempt += 1) {
      let reply: PluginCallReply;
      try {
        reply = await deps.invoke(rec.pluginId, method, "{}");
      } catch {
        return null;
      }
      if (reply?.ok) return reply.result;
      if (reply?.error?.code !== "rate_limited" || attempt === HOST_CALL_ATTEMPTS) return null;
      const hint = reply.error.retry_after_ms;
      const wait = typeof hint === "number" ? Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, hint)) : RETRY_DEFAULT_MS;
      await sleep(wait);
      if (!isLive(rec)) return null;
    }
    return null;
  };

  const onMessage = (event: HostMessage) => {
    const action = route(map, {
      origin: event.origin,
      source: event.source as FrameWindow | null,
      data: event.data,
    });
    if (action.kind === "reply") post(action.rec, action.msg);
    else if (action.kind === "pong") pongs.forEach((listener) => listener(action.rec.mountKey, action.seq));
    else if (action.kind === "call") {
      const extra = extras.get(action.rec);
      if (extra) void forward(action.rec, extra, action.callId, action.method, action.args);
    }
  };

  const unmap = (mountKey: string) => {
    const rec = map.detach(mountKey);
    if (rec) extras.get(rec)?.calls.clear();
    return rec;
  };

  // Reported only when no other frame of the plugin is left, so a remount does not release what the
  // newer frame opened.
  const detach = (mountKey: string) => {
    const rec = unmap(mountKey);
    if (rec && map.byPlugin(rec.pluginId).length === 0) deps.frameGone?.(rec.pluginId);
  };

  /** The plugin's newest live record whose init is done. Never a record of another plugin. */
  const initialised = (pluginId: string) => {
    const recs = map.byPlugin(pluginId);
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
    attach(mountKey, pluginId, source) {
      unmap(mountKey);
      const holder = map.get(source);
      if (holder) unmap(holder.mountKey);
      const rec: FrameRecord<FrameWindow> = { mountKey, pluginId, source, loads: 0, pending: 0, dead: false };
      map.attach(source, rec);
      extras.set(rec, { calls: new Set(), pageOpen: false, init: "none", theme: null, route: null });
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
      const [info, methods] = await Promise.all([hostCall(rec, "app.info"), hostCall(rec, "app.methods")]);
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

/**
 * Tells Rust how a plugin's frame stands. Best-effort: Rust's own deadlines still free what a lost
 * report would have released, and the next report overwrites a stale one.
 */
export function reportFrame(pluginId: string, kind: PluginFrameEventKind, reason?: PluginFrameCrashReason): void {
  pluginFrameEvent(pluginId, kind, reason).catch(() => {});
}

/** The production dependencies: the real window, the `plugin_call` command and the theme runtime. */
export function browserHostDeps(): HostDeps {
  return {
    addListener: (onMessage) => {
      const handler = (event: MessageEvent) => onMessage(event);
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    },
    invoke: pluginCall,
    theme: () => (isDarkTheme() ? "dark" : "light"),
    subscribeTheme,
    sleep: defaultSleep,
    frameGone: (pluginId) => {
      const health = useFrameHealthStore.getState().health[pluginId];
      const crashed = health?.phase === "crashed";
      reportFrame(pluginId, crashed ? "crashed" : "detached", crashed ? health.reason : undefined);
      if (crashed) useSidebarState.getState().drop(pluginId);
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
export function attachFrame(mountKey: string, pluginId: string, source: FrameWindow): void {
  active?.attach(mountKey, pluginId, source);
}

/**
 * Forgets a frame. Answers still in flight for it are dropped. When it was the plugin's last frame, Rust
 * hears that it detached or crashed, which ends the plugin's open toasts and prompts.
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
