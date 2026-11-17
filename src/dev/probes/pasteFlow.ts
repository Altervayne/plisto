/*
 * What happens to one paste event: it is routed against the hold open at that moment, the image is read,
 * the holding probe judges it, and its line and verdict reach the card. A paste that arrived while a hold
 * was open is judged even if the hold ends while the image decodes: the judging needs only the pasted
 * image and what the probe captured when it set the case up. The page's hook calls this, as do the tests.
 */

// -- Local Imports --
import { deliverPaste } from "./cardActions";
import { routePaste } from "./hold";

// -- Type Imports --
import type { Rgba } from "./pixelDiff";
import type { ActionVerdict, HoldRequest, PastedLayout } from "./types";

/** The hold that was open when the paste arrived. */
export interface OpenHold {
  id: string;
  request: HoldRequest;
  layout: PastedLayout;
  dpr: number;
}

export interface PasteDeps {
  read(file: Blob): Promise<Rgba>;
  appendLine(id: string, line: string): void;
  applyVerdict(id: string, verdict: ActionVerdict): void;
}

export interface PasteHandling {
  /** The paste was an image for an open hold, so the event's default should be prevented. */
  handled: boolean;
  /** Settles when the paste has been judged and its result is on the card. */
  done: Promise<void>;
}

/**
 * Handles one paste. `types` are the clipboard item types and `takeFile` reads an item's file; it is called
 * at once, because a clipboard item is only readable while the event runs. A paste with no hold open, or with
 * no image, is ignored with a line on `lastCard` (the card that last held or asked something).
 */
export function handlePaste(
  open: OpenHold | null,
  lastCard: string | null,
  types: readonly string[],
  takeFile: (index: number) => Blob | null,
  deps: PasteDeps,
): PasteHandling {
  const route = routePaste(open !== null, types);
  if (route.kind === "ignored" || !open) {
    const id = open?.id ?? lastCard;
    if (id) deps.appendLine(id, route.kind === "ignored" ? route.line : "paste ignored");
    return { handled: false, done: Promise.resolve() };
  }
  const fail = (error: unknown) =>
    deps.appendLine(open.id, `paste failed: ${error instanceof Error ? error.message : String(error)}`);
  const file = takeFile(route.index);
  if (!file) {
    fail(new Error("the clipboard image could not be read"));
    return { handled: true, done: Promise.resolve() };
  }
  const done = deps
    .read(file)
    .then((image) => open.request.onPaste({ image, dpr: open.dpr, layout: open.layout }))
    .then(
      (answer) =>
        deliverPaste(
          answer,
          (line) => deps.appendLine(open.id, line),
          (verdict) => deps.applyVerdict(open.id, verdict),
        ),
      fail,
    );
  return { handled: true, done };
}
