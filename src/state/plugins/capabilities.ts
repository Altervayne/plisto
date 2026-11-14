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
  "audio.events": 2,
  "audio.tap": 3,
  "audio.device": 4,
  "audio.output_takeover": 5,
  "playback.control": 6,
  "playback.stream": 7,
  "ui.sidebar": 8,
  "ui.chips": 9,
  "ui.toast": 10,
  "ui.confirm": 11,
  storage: 12,
  background: 13,
  network: 14,
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
