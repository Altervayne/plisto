/*
 * Mounts a kind the way the Player does: in a sandboxed frame on the plugin's own origin, then one
 * `plisto:vis-init` window message that transfers a MessagePort; everything after travels on the port. The
 * live mount ticks through the transport. The still is a second mount that is never ticked, as reduced
 * motion shows it.
 */

// -- Local Imports --
import { buildInit } from "./context.js";
import { createTransport } from "./transport.js";

const STILL_WAIT_MS = 20000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A square sunset gradient as an ImageBitmap, flipped for GL as the player hands the cover over. */
export function coverBitmap() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, "#2a8aa0");
  grad.addColorStop(0.55, "#1b4560");
  grad.addColorStop(1, "#e0644f");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return createImageBitmap(canvas, { imageOrientation: "flipY" });
}

/** Creates the frame for a kind inside `parent`, sized to `layout`, and resolves once it has loaded. */
async function loadFrame(parent, src, layout) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = "Visualizer";
  frame.style.width = `${layout.width}px`;
  frame.style.height = `${layout.height}px`;
  frame.src = src;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  parent.appendChild(frame);
  await loaded;
  return frame;
}

/**
 * Mounts `kind` (`{ decl, src }`) with `context`. `onMessage(message, nowMs)` hears every frame message.
 * Resolves with the frame, the transport and `startedAt`, the time the init was sent.
 */
export async function openMount({ kind, context, meter, parent, isVisible, onMessage }) {
  const frame = await loadFrame(parent, kind.src, context.layout);
  const { port1, port2 } = new MessageChannel();
  const transport = createTransport({ port: port1, isVisible, onFrameMessage: onMessage });
  const startedAt = performance.now();
  frame.contentWindow.postMessage(buildInit(kind.decl, context, meter), "*", [port2]);
  return {
    frame,
    transport,
    startedAt,
    close() {
      transport.dispose();
      frame.remove();
    },
  };
}

/** The still of a fresh, never-ticked mount as a PNG data URL, or the reason there is none. */
export async function stillOf({ kind, context, parent }) {
  let reply = null;
  const quiet = { ...context, reducedMotion: true };
  const frame = await loadFrame(parent, kind.src, quiet.layout);
  frame.style.opacity = "0.01";
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "still") reply = m;
    else if (m && m.type === "error") reply = { error: m.message };
  };
  frame.contentWindow.postMessage(buildInit(kind.decl, quiet, false), "*", [port2]);
  port1.postMessage({ type: "still", id: 1 });
  for (let waited = 0; reply === null && waited < STILL_WAIT_MS; waited += 50) await sleep(50);
  port1.postMessage({ type: "dispose" });
  port1.close();
  frame.remove();
  if (reply === null) return { error: `no still within ${STILL_WAIT_MS / 1000} s` };
  if (reply.error) return { error: reply.error };
  if (!reply.bitmap) return { error: "the kind gave no still" };
  const canvas = document.createElement("canvas");
  canvas.width = reply.bitmap.width;
  canvas.height = reply.bitmap.height;
  canvas.getContext("2d").drawImage(reply.bitmap, 0, 0);
  reply.bitmap.close();
  return { png: canvas.toDataURL("image/png") };
}
