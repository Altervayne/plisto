/*
 * The harness's Channel box. It plays the plugin's page: a JSON message typed here reaches the mounted frame
 * as the relay would deliver it, and what the frame sends is listed with the same size limit and rate Plisto
 * applies. The init the harness sends sets `channel`, so `plistoVis.channel` exists in every kind.
 */

// -- Local Imports --
import { CHANNEL_METHOD, channelText } from "../lib/protocol.js";
import { el } from "./controls.js";

const PER_SEC = 20;
const LINES_MAX = 100;

/** Builds the box in `root`; `frameOf()` gives the mounted kind's frame, or null while none is mounted. */
export function mountChannelBox(root, frameOf) {
  const input = el("textarea", { rows: 2, "aria-label": "Message as JSON", placeholder: '{"level": 1}' });
  const send = el("button", { type: "button", text: "Send to the frame" });
  const lines = el("pre", { class: "log", "aria-label": "Channel log" });
  const note = (text) => {
    const older = lines.textContent.split("\n").filter(Boolean);
    const next = [`${new Date().toLocaleTimeString()} ${text}`, ...older];
    lines.textContent = next.slice(0, LINES_MAX).join("\n");
  };

  send.addEventListener("click", () => {
    const frame = frameOf();
    try {
      const data = JSON.parse(input.value);
      channelText(data);
      if (!frame) throw new Error("no frame is mounted");
      frame.contentWindow.postMessage({ plisto: 1, type: "plisto:channel", data }, "*");
      note(`page -> frame: ${JSON.stringify(data)}`);
    } catch (e) {
      note(`not sent: ${e.message}`);
    }
  });

  let sentAt = [];
  window.addEventListener("message", (event) => {
    const frame = frameOf();
    const d = event.data;
    if (!frame || event.source !== frame.contentWindow || !d || d.plisto !== 1) return;
    if (d.type !== "plisto:call" || d.method !== CHANNEL_METHOD) return;
    const now = performance.now();
    sentAt = sentAt.filter((t) => now - t < 1000);
    // Like Plisto, the frame is answered whether or not the message is kept.
    event.source.postMessage({ plisto: 1, type: "plisto:result", id: d.id, ok: true, result: null }, "*");
    if (sentAt.length >= PER_SEC) return note(`frame -> page: dropped, over ${PER_SEC} a second`);
    sentAt.push(now);
    try {
      note(`frame -> page: ${channelText(JSON.parse(d.args).data)}`);
    } catch (e) {
      note(`frame -> page: dropped, ${e.message}`);
    }
  });

  root.replaceChildren(el("h2", { text: "Channel" }), input, send, lines);
}
