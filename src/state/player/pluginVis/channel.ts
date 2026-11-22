/*
 * The page channel's relay: messages between a plugin's page or background frame and its shown visualizer
 * frames, and only between frames of the same plugin. A visualizer frame's messages reach every page and
 * background frame; a page's reach every shown stage frame, or only those of one kind. A frame that is
 * not shown, kept hidden or still compiling under the dip, neither sends nor receives, and a still or a
 * thumbnail mount is never a stage. Each sending frame may send 20 messages in any one second, the size
 * is checked again here, and a message that cannot be delivered is dropped without a word to its sender;
 * in developer mode the drop is logged to the plugin's log, once a second per plugin and reason.
 */
// -- State Imports --
import { channelMsg } from "../../plugins/bridge";
import { usePluginsStore } from "../../plugins/store";
import { isShownStage, stageHandles } from "./frameCache";

// -- Local Imports --
import { CHANNEL_MAX_BYTES, utf8Length } from "../../../visRuntime/protocol";

// -- Type Imports --
import type { HostToFrame } from "../../plugins/bridge";
import type { PluginRow } from "../../../types";

/** The most messages a frame may send in any one-second window. */
export const CHANNEL_RATE_PER_SEC = 20;
/** The window the rate is counted over. */
export const CHANNEL_WINDOW_MS = 1000;
/** The shortest gap between two log lines for the same plugin and drop reason. */
export const DROP_LOG_GAP_MS = 1000;

export type DropReason = "rate" | "size" | "absent" | "sender" | "malformed";

const DROP_LINES: Record<DropReason, string> = {
  rate: `channel message dropped: more than ${CHANNEL_RATE_PER_SEC} a second from one frame`,
  size: `channel message dropped: over ${CHANNEL_MAX_BYTES} bytes`,
  absent: "channel message dropped: no frame on the other side",
  sender: "channel message dropped: not sent by a page frame or a live visualizer of this plugin",
  malformed: "channel message dropped: not a JSON message",
};

/** The fields of a frame record the relay reads. */
export interface RelayFrame {
  mountKey: string;
  pluginId: string;
  role?: "page" | "visualizer";
}

export interface RelayDeps<F extends RelayFrame> {
  now: () => number;
  // The plugin's live frame records.
  frames: (pluginId: string) => readonly F[];
  deliver: (frame: F, message: HostToFrame) => void;
  devMode: () => boolean;
  // Whether the stage frame of `kind` on `surface` is on screen. Defaults to the stage handles' own answer.
  shown?: (surface: string, kind: string) => boolean;
  // Writes one line to the plugin's log.
  log: (pluginId: string, line: string) => void;
}

export interface ChannelRelay<F extends RelayFrame> {
  // Takes the JSON arguments of one `channel.send` call from `sender`.
  relay: (sender: F, args: string) => void;
}

const STAGE_SURFACES = ["player", "ambient"];

/**
 * The surface and plugin kind id of a stage frame, read from its mount key (`vis|<surface>|<kind id>|...`),
 * or null for any other visualizer frame: a still's key reads `vis|still|...`.
 */
export function stageOf(mountKey: string): { surface: string; kind: string } | null {
  const [head, surface, kind] = mountKey.split("|");
  return head === "vis" && STAGE_SURFACES.includes(surface) && kind ? { surface, kind } : null;
}

/** The kind id of a stage frame, or null. */
export const stageKindOf = (mountKey: string): string | null => stageOf(mountKey)?.kind ?? null;

const shownOnStage = (surface: string, kind: string) =>
  stageHandles().some((h) => h.surface === surface && h.kind === kind && isShownStage(h));

/** The kind's own id when `kind` is a kind of `pluginId`, else null. */
function localKind(pluginId: string, kind: string | null): string | null {
  const prefix = `${pluginId}/`;
  return kind?.startsWith(prefix) ? kind.slice(prefix.length) : null;
}

export function createChannelRelay<F extends RelayFrame>(deps: RelayDeps<F>): ChannelRelay<F> {
  const sent = new WeakMap<F, number[]>();
  const shown = deps.shown ?? shownOnStage;
  // A visualizer frame counts only while its stage shows it.
  const live = (frame: F): string | null => {
    const stage = stageOf(frame.mountKey);
    return stage && shown(stage.surface, stage.kind) ? localKind(frame.pluginId, stage.kind) : null;
  };
  const lastLogged = new Map<string, number>();

  const drop = (pluginId: string, reason: DropReason) => {
    if (!deps.devMode()) return;
    const key = `${pluginId}|${reason}`;
    const at = deps.now();
    const prev = lastLogged.get(key);
    if (prev !== undefined && at - prev < DROP_LOG_GAP_MS) return;
    lastLogged.set(key, at);
    deps.log(pluginId, DROP_LINES[reason]);
  };

  // Keeps the sends of the last second; one more passes only while fewer than the limit are held.
  const spend = (sender: F): boolean => {
    const at = deps.now();
    const held = (sent.get(sender) ?? []).filter((t) => at - t < CHANNEL_WINDOW_MS);
    sent.set(sender, held);
    if (held.length >= CHANNEL_RATE_PER_SEC) return false;
    held.push(at);
    return true;
  };

  return {
    relay(sender, args) {
      const { pluginId } = sender;
      const fromVisualizer = sender.role === "visualizer";
      const senderKind = fromVisualizer ? live(sender) : null;
      if (fromVisualizer && senderKind === null) return drop(pluginId, "sender");
      if (!spend(sender)) return drop(pluginId, "rate");

      let body: { data?: unknown; kind?: unknown } | null = null;
      let text: string | undefined;
      try {
        body = JSON.parse(args);
        text = body !== null && typeof body === "object" ? JSON.stringify(body.data) : undefined;
      } catch {
        text = undefined;
      }
      if (body === null || typeof text !== "string") return drop(pluginId, "malformed");
      if (utf8Length(text) > CHANNEL_MAX_BYTES) return drop(pluginId, "size");
      const only = typeof body.kind === "string" ? body.kind : null;
      if (body.kind !== undefined && only === null) return drop(pluginId, "malformed");

      const own = deps.frames(pluginId).filter((f) => f.pluginId === pluginId);
      const targets = fromVisualizer
        ? own.filter((f) => f.role !== "visualizer")
        : own.filter((f) => {
            if (f.role !== "visualizer") return false;
            const kind = live(f);
            return kind !== null && (only === null || kind === only);
          });
      if (targets.length === 0) return drop(pluginId, "absent");
      // A page hears which kind spoke; a visualizer frame hears the data alone.
      const message = channelMsg(body.data, senderKind === null ? undefined : { kind: senderKind });
      for (const target of targets) deps.deliver(target, message);
    },
  };
}

/** Whether a plugin row has a page or a background frame for a visualizer frame to talk to. */
export function hasPageFrame(row: Pick<PluginRow, "tier" | "manifest"> | undefined): boolean {
  if (!row?.manifest) return false;
  return row.tier === "ui" ? row.manifest.entry !== null : row.manifest.page !== null;
}

/** Whether the installed plugin has such a frame now. */
export function pluginHasPage(pluginId: string): boolean {
  return hasPageFrame(usePluginsStore.getState().rows.find((row) => row.id === pluginId));
}
