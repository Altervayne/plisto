/*
 * Mounts a probe frame the way the plugin host mounts a plugin page: a sandboxed iframe without
 * same-origin, no permissions, strict referrer. The page hands the frame a MessagePort once the document
 * has loaded and waits for the frame's `ready` message over it (fixtures/common.js is the frame side).
 */

export type ProbeHost = "probe-ui0" | "probe-ui0s" | "probe-ui1" | "probe-vis" | "probe-vis2";

export interface ReadyMessage {
  type: "ready";
  host: string;
}

export interface MountedFrame {
  el: HTMLIFrameElement;
  /** The page's end of the channel to the frame. */
  port: MessagePort;
  ready: ReadyMessage;
  /** `performance.now()` just before the element was inserted. */
  insertedAt: number;
  /** `performance.now()` when `ready` arrived. */
  readyAt: number;
  unmount(): void;
}

export interface MountOptions {
  host: ProbeHost;
  /** A flat file name in the fixtures folder, with an optional query. */
  file: string;
  parent: HTMLElement;
  className?: string;
  /** Frame size before it loads: a number is CSS pixels, a string any CSS length such as "100%". */
  width?: number | string;
  height?: number | string;
  /** Removes the frame's border. */
  borderless?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function probeUrl(host: ProbeHost, file: string): string {
  return `https://${host}.invalid/${file}`;
}

/** The attributes every probe frame carries, matching the plugin frame's. */
export function applyFrameAttributes(el: HTMLIFrameElement): void {
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("allow", "");
  el.referrerPolicy = "strict-origin";
  el.style.colorScheme = "normal";
  el.title = "probe frame";
}

/** A CSS length from a pixel count or a ready-made string. */
export function cssLength(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

/** Applies the size and border options of `opts` to a frame that has not loaded yet. */
export function applyFrameSize(el: HTMLIFrameElement, opts: Pick<MountOptions, "width" | "height" | "borderless">): void {
  if (opts.width !== undefined) el.style.width = cssLength(opts.width);
  if (opts.height !== undefined) el.style.height = cssLength(opts.height);
  if (opts.borderless) el.style.border = "0";
}

/** Inserts a frame, passes it a port when it loads, and resolves when it answers `ready`. */
export function mountProbeFrame(opts: MountOptions): Promise<MountedFrame> {
  const { host, file, parent, className, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    const el = document.createElement("iframe");
    applyFrameAttributes(el);
    applyFrameSize(el, opts);
    if (className) el.className = className;
    const channel = new MessageChannel();
    const unmount = () => {
      channel.port1.close();
      el.remove();
    };
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unmount();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail(`frame ${host} not ready after ${timeoutMs} ms`), timeoutMs);
    if (signal?.aborted) return fail("aborted");
    signal?.addEventListener("abort", () => fail("aborted"), { once: true });

    const insertedAt = performance.now();
    channel.port1.onmessage = (e: MessageEvent) => {
      const data = e.data as Partial<ReadyMessage> | null;
      if (data?.type !== "ready" || settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      resolve({
        el,
        port: channel.port1,
        ready: { type: "ready", host: String(data.host ?? "") },
        insertedAt,
        readyAt: performance.now(),
        unmount,
      });
    };
    // The sandboxed frame has an opaque origin, so the target origin cannot name it.
    el.addEventListener("load", () => el.contentWindow?.postMessage({ probe: "port" }, "*", [channel.port2]), {
      once: true,
    });
    el.src = probeUrl(host, file);
    parent.appendChild(el);
  });
}
