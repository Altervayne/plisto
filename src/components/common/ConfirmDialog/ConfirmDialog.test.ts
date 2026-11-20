// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// The dialog reads as a plain element tree once its portal, effects and mount point are stood in for.
vi.stubGlobal("document", { body: {} });
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
const effects = vi.hoisted(() => ({ deps: [] as unknown[][] }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (_fn: unknown, deps: unknown[]) => {
    effects.deps.push(deps);
  },
  useRef: () => ({ current: null }),
}));

// -- Unit Imports --
import { ConfirmDialog } from "./ConfirmDialog";

// -- Type Imports --
import type { ReactElement, ReactNode } from "react";

type El = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
  role?: string;
  "data-plugin-prompt"?: string;
}>;

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

  it("carries no plugin mark and no identity band by default", () => {
    const { all } = render({ identity: { icon: "i", name: "Tandem", line: "From a plugin" } });
    const dialog = all.find((e) => e.props.role === "alertdialog");
    expect(dialog?.props["data-plugin-prompt"]).toBeUndefined();
    expect(JSON.stringify(all.map((e) => e.props.children))).not.toContain("From a plugin");
  });

  it("keys its focus effect on the dialog state, never on the close handler", () => {
    effects.deps.length = 0;
    render({ onClose: () => {} });
    render({ onClose: () => {} });
    expect(effects.deps).toHaveLength(2);
    for (const deps of effects.deps) {
      expect(deps.some((d) => typeof d === "function")).toBe(false);
      expect(deps).toEqual(effects.deps[0]);
    }
  });

  it("is the narrow card, with a prompt line, unless asked otherwise", () => {
    const { all } = render();
    const dialog = all.find((e) => e.props.role === "alertdialog");
    expect(dialog?.props.className).not.toContain("wide");
    expect(all.some((e) => e.type === "p")).toBe(true);
  });

  it("takes the wide card for a sheet with a list", () => {
    const { all } = render({ width: "wide" });
    const dialog = all.find((e) => e.props.role === "alertdialog");
    expect(dialog?.props.className).toContain("wide");
  });

  it("leaves the prompt line out when it is empty, keeping the title", () => {
    const { all } = render({ prompt: "", title: "Done" });
    expect(all.some((e) => e.type === "p")).toBe(false);
    expect(all.find((e) => e.type === "h2")?.props.children).toBe("Done");
  });

  it("drops Cancel on request, leaving the secondary and the confirm as the two answers", () => {
    const onClick = vi.fn();
    const { buttons, onClose, onConfirm } = render({ hideCancel: true, secondary: { label: "Undo", onClick } });
    expect(buttons.map((b) => b.props.children)).toEqual(["Undo", "Yes"]);
    buttons[1].props.onClick?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("plugin variant", () => {
    const identity = { icon: "i", name: "Tandem", line: "From a plugin" };

    it("marks the dialog and draws the identity band", () => {
      const { all } = render({ variant: "plugin", identity });
      const dialog = all.find((e) => e.props.role === "alertdialog");
      expect(dialog?.props["data-plugin-prompt"]).toBe("");
      const band = all.find((e) => e.props.children === "From a plugin");
      expect(band).toBeDefined();
      expect(all.some((e) => e.props.children === "i")).toBe(true);
    });

    it("never applies the destructive or accent class to the confirm", () => {
      const plain = render({ variant: "plugin", identity });
      const loud = render({ variant: "plugin", identity, destructive: true, accent: true });
      expect(loud.buttons[1].props.className).toBe(plain.buttons[1].props.className);
      const tinted = render({ destructive: true, accent: true });
      expect(tinted.buttons[1].props.className).not.toBe(plain.buttons[1].props.className);
    });

    it("keeps Cancel and the confirm behavior", () => {
      const { buttons, onConfirm, onClose } = render({ variant: "plugin", identity });
      expect(buttons.map((b) => b.props.children)).toEqual(["No", "Yes"]);
      buttons[1].props.onClick?.();
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
