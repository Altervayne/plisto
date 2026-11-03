// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// The dialog reads as a plain element tree once its portal, effects and mount point are stood in for.
vi.stubGlobal("document", { body: {} });
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => {},
  useRef: () => ({ current: null }),
}));

// -- Unit Imports --
import { ConfirmDialog } from "./ConfirmDialog";

// -- Type Imports --
import type { ReactElement, ReactNode } from "react";

type El = ReactElement<{ children?: ReactNode; onClick?: () => void; className?: string }>;

/** Every element in a rendered tree, depth first. */
function walk(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props.children, out);
  }
  return out;
}

const render = (extra: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const tree = ConfirmDialog({
    open: true,
    prompt: "Sure?",
    confirmLabel: "Yes",
    cancelLabel: "No",
    onConfirm,
    onClose,
    ...extra,
  }) as El;
  const all = walk(tree);
  const buttons = all.filter((e) => e.type === "button");
  return { all, buttons, onConfirm, onClose };
};

describe("ConfirmDialog", () => {
  it("renders just Cancel and the confirm, with no heading, by default", () => {
    const { all, buttons } = render();
    expect(buttons.map((b) => b.props.children)).toEqual(["No", "Yes"]);
    expect(all.some((e) => e.type === "h2")).toBe(false);
  });

  it("renders a title above the prompt", () => {
    const { all } = render({ title: "Heads up" });
    const heading = all.find((e) => e.type === "h2");
    expect(heading?.props.children).toBe("Heads up");
  });

  it("puts the secondary between Cancel and the confirm, and it closes the dialog", () => {
    const onClick = vi.fn();
    const { buttons, onClose, onConfirm } = render({ secondary: { label: "Other", onClick } });
    expect(buttons.map((b) => b.props.children)).toEqual(["No", "Other", "Yes"]);
    buttons[1].props.onClick?.();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms then closes", () => {
    const { buttons, onClose, onConfirm } = render();
    buttons[1].props.onClick?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
