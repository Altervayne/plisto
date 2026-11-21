/*
 * The closed capability set in the order a review sheet lists it: what the plugin reads, what it
 * controls, what it reaches, then what it shows. Keyed so a capability added to the union fails the
 * build until it is placed here.
 */

// -- Type Imports --
import type { PluginCapability } from "../../types";

const ORDER: Record<PluginCapability, number> = {
  "playback.read": 0,
  "library.read": 1,
  visualizer: 2,
  "visualizer.waveform": 3,
  "audio.events": 4,
  "audio.tap": 5,
  "audio.device": 6,
  "audio.output_takeover": 7,
  "playback.control": 8,
  "playback.stream": 9,
  "ui.sidebar": 10,
  "ui.chips": 11,
  "ui.toast": 12,
  "ui.confirm": 13,
  storage: 14,
  background: 15,
  network: 16,
};

const ORDER_END = 1000;

export const ALL_CAPABILITIES = Object.keys(ORDER) as PluginCapability[];

const rank = (cap: PluginCapability): number => (isKnown(cap) ? ORDER[cap] : ORDER_END);
const isKnown = (cap: string): cap is PluginCapability => Object.prototype.hasOwnProperty.call(ORDER, cap);

/** The capabilities this Plisto has a label for. A newer manifest's extra values are left out of lists. */
export const knownCapabilities = (caps: PluginCapability[]): PluginCapability[] => caps.filter(isKnown);

/** The capabilities in sheet order, without changing the input. */
export function sortCapabilities(caps: PluginCapability[]): PluginCapability[] {
  return [...caps].sort((a, b) => rank(a) - rank(b));
}
