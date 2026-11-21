/*
 * The host side of a checker run, in the page Edge loads. It does what Plisto's player does for each kind:
 * puts it in a sandboxed frame, posts `plisto:vis-init` with a MessageChannel port, then sends one scripted
 * tick per display frame under the credit window, with the flash meter on. A second mount that is never
 * ticked gives the still. What the frame reports (ready, errors, acks with step costs, flash readings) is
 * gathered per kind and left as JSON in #out for the checker to judge. The job comes from job.json.
 */

// -- Local Imports --
import { createFeed } from "./feed.js";
import { VIS_INIT_TYPE, createTickSender } from "./protocol.js";

// The player layout the lab calibrated the limits on, at pixel ratio 1.
const LAYOUT = {
  width: 1000,
  height: 680,
  cover: [330, 90, 340, 340],
  radius: 16,
  mask: [160, 40, 680, 480],
  floor: 600,
  hush: [
    [300, 450, 400, 28],
    [320, 484, 360, 20],
  ],
};
const PALETTE = [224, 100, 79, 42, 138, 160, 246, 201, 138].map((v) => v / 255);
const COLORS = { ground: [0.063, 0.071, 0.086], backing: [0.09, 0.098, 0.118], ink: [0.93, 0.94, 0.96] };
const STILL_WAIT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A square sunset gradient, flipped for GL as the player hands the cover over. */
function coverBitmap() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext("2d");
  const lin = g.createLinearGradient(0, 0, 256, 256);
  lin.addColorStop(0, "#2a8aa0");
  lin.addColorStop(0.55, "#1b4560");
  lin.addColorStop(1, "#e0644f");
  g.fillStyle = lin;
  g.fillRect(0, 0, 256, 256);
  return createImageBitmap(canvas, { imageOrientation: "flipY" });
}

function initFor(kind, cover, live) {
  const { decl } = kind;
  const settings = {};
  for (const s of decl.settings) settings[s.id] = s.default;
  return {
    plisto: 1,
    type: VIS_INIT_TYPE,
    api: decl.api,
    kind: decl.id,
    composite: { light: decl.look.light.composite, dark: decl.look.dark.composite },
    fillsStage: decl.fillsStage,
    needs: decl.needs,
    settingShapes: decl.settings.map((s) => ({
      id: s.id,
      type: s.type,
      ...(s.type === "choice" && { options: s.options.map((o) => o.id) }),
    })),
    meter: live,
    context: {
      layout: LAYOUT,
      palette: Float32Array.from(PALETTE),
      cover,
      colors: COLORS,
      light: false,
      reactivity: "balanced",
      ambient: false,
      reducedMotion: !live,
      settings,
    },
  };
}

/** Puts the kind in a sandboxed frame and sends its init; `onMessage` hears what the frame reports. */
async function openMount(kind, live, onMessage) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  const { width, height } = LAYOUT;
  frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;border:0`;
  frame.src = kind.src;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.appendChild(frame);
  await loaded;
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = (e) => onMessage(e.data, performance.now());
  const cover = kind.decl.needs.cover ? await coverBitmap() : null;
  const startedAt = performance.now();
  frame.contentWindow.postMessage(initFor(kind, cover, live), "*", [port2]);
  return {
    port1,
    startedAt,
    close() {
      port1.postMessage({ type: "dispose" });
      port1.close();
      frame.remove();
    },
  };
}

/** The still of a fresh mount that is never ticked, as a PNG data URL, or the reason there is none. */
async function stillOf(kind) {
  let reply = null;
  const mount = await openMount(kind, false, (m) => {
    if (m.type === "still") reply = m;
    else if (m.type === "error") reply = { error: m.message };
  });
  mount.port1.postMessage({ type: "still", id: 1 });
  for (let waited = 0; reply === null && waited < STILL_WAIT_MS; waited += 50) await sleep(50);
  mount.close();
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

/** Mounts one kind and plays the scripted feed for `seconds` after it is ready. */
async function runKind(kind, seconds, readyWaitMs) {
  const result = { id: kind.decl.id, readyMs: null, metered: false, flash: [], frames: [], runMs: 0 };
  result.error = null;
  const sender = createTickSender((tick) => mount.port1.postMessage({ type: "tick", ...tick }));
  let readyAt = null;
  const mount = await openMount(kind, true, (m, now) => {
    if (m.type === "ack") {
      sender.ack(m.seq);
      if (readyAt !== null) result.frames.push({ at: now - readyAt, ms: m.ms });
    } else if (m.type === "ready") {
      readyAt = now;
      result.readyMs = now - mount.startedAt;
      result.metered = m.metered;
    } else if (m.type === "metered") result.metered = true;
    else if (m.type === "flash") result.flash.push(m.reading);
    else if (m.type === "lost") result.error = { stage: "draw", message: "the graphics context was lost" };
    else if (m.type === "error") result.error = { stage: m.stage, message: m.message };
  });

  const feed = createFeed(kind.decl.needs);
  const startedAt = mount.startedAt;
  // One tick per display frame until the run is over, the kind fails, or it never draws.
  await new Promise((resolve) => {
    let last = startedAt;
    const step = (now) => {
      const late = readyAt === null && now - startedAt > readyWaitMs;
      if (result.error || late || (readyAt !== null && now - readyAt >= seconds * 1000)) {
        if (late && !result.error) {
          const message =
            `no first frame within ${readyWaitMs / 1000} s of the init; the page may not have registered ` +
            "its kind, or its script threw before it did";
          result.error = { stage: "ready", message };
        }
        result.runMs = readyAt === null ? 0 : now - readyAt;
        resolve();
        return;
      }
      sender.offer(feed.next((now - startedAt) / 1000, Math.max(0, (now - last) / 1000)));
      last = now;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  mount.close();
  if (readyAt === null || result.error) return result;
  const still = await stillOf(kind);
  if (still.png) result.png = still.png;
  else result.stillError = still.error;
  return result;
}

async function main() {
  const job = await (await fetch("job.json")).json();
  const results = [];
  for (const kind of job.kinds) results.push(await runKind(kind, job.seconds, job.readyWaitMs));
  return { results };
}

main()
  .catch((e) => ({ error: String(e && e.message ? e.message : e) }))
  .then((out) => {
    document.getElementById("out").textContent = JSON.stringify(out);
    document.body.dataset.done = "1";
  });
