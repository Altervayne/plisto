// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dialog reads as a plain element tree once its portal, effects, refs and translator are stood in for.
const keyListeners: ((event: { key: string }) => void)[] = [];
vi.stubGlobal("document", { body: {} });
vi.stubGlobal("window", {
  addEventListener: (_: string, fn: (event: { key: string }) => void) => keyListeners.push(fn),
  removeEventListener: () => {},
});
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => void effect(),
  useRef: () => ({ current: null }),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("../../i18n", async () => {
  const { en } = await import("../../i18n/en");
  return { useT: () => (pick: (d: typeof en) => string) => pick(en) };
});

// -- Unit Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";
import { SafeModeOfferDialog } from "./SafeModeOfferDialog";
import { en } from "../../i18n/en";

// -- Type Imports --
import type { ReactElement, ReactNode } from "react";

type El = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
  "aria-hidden"?: string | boolean;
}>;

function walk(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props.children, out);
  }
  return out;
}

const onAnswer = vi.fn();

/** The dialog the offer draws, rendered one level down to its buttons and backdrop. */
function render() {
  const offer = SafeModeOfferDialog({ open: true, onAnswer }) as ReactElement<Parameters<typeof ConfirmDialog>[0]>;
  const all = walk(ConfirmDialog(offer.props) as El);
  return {
    buttons: all.filter((e) => e.type === "button"),
    backdrop: all.find((e) => e.props["aria-hidden"] != null),
  };
}

beforeEach(() => {
  onAnswer.mockReset();
  keyListeners.length = 0;
});

describe("the safe mode offer dialog", () => {
  it("answers false from Start normally and true from Start without plugins", () => {
    const { buttons } = render();
    expect(buttons.map((b) => b.props.children)).toEqual([
      en.plugins.safeOffer.startNormally,
      en.plugins.safeOffer.startSafe,
    ]);
    buttons[0].props.onClick?.();
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    buttons[1].props.onClick?.();
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it("ignores Escape and the backdrop: the choice is required", () => {
    const { backdrop } = render();
    keyListeners.forEach((fn) => fn({ key: "Escape" }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(backdrop?.props.onClick).toBeUndefined();
  });
});
