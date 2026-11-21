/*
 * Where Settings lists a plugin: the Visualizers catalog only, or the Plugins list as well. It is the
 * catalog only when everything the plugin is or does shows as tiles there, the rule of Plisto's own listing.
 * The answer carries the reasons, so an author sees what moved the plugin into the Plugins list.
 */

// The capabilities a visualizer frame uses; anything else puts the plugin in the Plugins list.
const FRAME_CAPABILITIES = ["visualizer", "visualizer.waveform", "storage", "playback.read", "library.read"];

/** `{ listing: "catalog" | "plugins", reasons }` for the facts `checkManifest` returns. */
export function listingOf({ tier, decls, caps, entry, hasSidebar }) {
  const reasons = [];
  if (tier !== "ui") reasons.push(`its tier is '${tier}', not 'ui'`);
  if (decls.length === 0 || !caps.includes("visualizer")) {
    reasons.push("it lists no visualizer or lacks 'visualizer'");
  }
  if (entry !== null) reasons.push(`it has a page of its own ('entry': ${entry})`);
  if (hasSidebar) reasons.push("it has a sidebar entry");
  const extra = caps.filter((c) => !FRAME_CAPABILITIES.includes(c));
  if (extra.length > 0) {
    const names = extra.map((c) => `'${c}'`).join(", ");
    reasons.push(`it holds ${names}, which a visualizer frame does not use`);
  }
  return { listing: reasons.length === 0 ? "catalog" : "plugins", reasons };
}

/** The listing as the user sees it, with the reasons when the plugin is in the Plugins list. */
export function listingText({ listing, reasons }) {
  if (listing === "catalog") {
    return "Visualizers only: tier 'ui', no page of its own, no sidebar, and only frame capabilities.";
  }
  return `Plugins list and Visualizers catalog: ${reasons.join("; ")}.`;
}
