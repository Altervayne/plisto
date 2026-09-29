// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { SegmentedControl } from "./SegmentedControl";

// -- Type Imports --
import type { ReactElement } from "react";

type Chip = ReactElement<{ "aria-disabled"?: boolean; onClick: () => void }>;

/** The rendered chips of a control, read straight off its element tree (it holds no hooks). */
function chips(onChange: (value: "a" | "b") => void): Chip[] {
  const root = SegmentedControl({
    segments: [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
    ],
    value: "a",
    onChange,
    label: "Pick",
  }) as ReactElement<{ children: Chip[] }>;
  return root.props.children;
}

describe("SegmentedControl", () => {
  it("marks only the disabled chip aria-disabled", () => {
    const [a, b] = chips(() => {});
    expect(a.props["aria-disabled"]).toBeUndefined();
    expect(b.props["aria-disabled"]).toBe(true);
  });

  it("ignores a click on a disabled chip", () => {
    const onChange = vi.fn();
    const [a, b] = chips(onChange);
    b.props.onClick();
    expect(onChange).not.toHaveBeenCalled();
    a.props.onClick();
    expect(onChange).toHaveBeenCalledWith("a");
  });
});
