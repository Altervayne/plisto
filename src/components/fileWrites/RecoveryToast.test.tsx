// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { RecoveryToast } from "./RecoveryToast";
import { recoveryLines } from "./recoveryLines";

// -- i18n Imports --
import { createT } from "../../i18n";

// -- Type Imports --
import type { RecoveryReport } from "../../state/fileWrites/store";

// The static renderer reads a zustand store at its initial state, so the report is fed through a stand-in.
const held = vi.hoisted(() => ({ report: null as RecoveryReport | null }));
vi.mock("../../state/fileWrites/store", () => ({
  useFileWritesRecovery: () => held.report,
  useFileWritesStore: (select: (s: { dismissRecovery: () => void }) => unknown) => select({ dismissRecovery: () => {} }),
}));
// The shared toast pill needs a DOM and a mount transition; the stand-in draws its children when visible.
vi.mock("../common/Toast/Toast", () => ({
  Toast: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <>{children}</> : null),
}));

beforeEach(() => {
  held.report = null;
});

describe("recoveryLines", () => {
  it("words each part of a report that has something in it, and skips the empty ones", () => {
    const t = createT("en");
    const lines = recoveryLines(t, { restored: 1, finished: 0, heldOffline: 2, needsAttention: [] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("put the original back");
    expect(lines[1]).toContain("2 files are on folders that are offline");
  });

  it("reads in French without a missing-string placeholder", () => {
    const lines = recoveryLines(createT("fr"), { restored: 2, finished: 1, heldOffline: 1, needsAttention: ["a"] });
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toContain("TO COMPLETE");
  });
});

describe("RecoveryToast", () => {
  it("draws nothing until a report arrives", () => {
    expect(renderToStaticMarkup(<RecoveryToast />)).toBe("");
  });

  it("draws the title and a Dismiss action, and offers Show only for a file needing a look", () => {
    held.report = { restored: 1, finished: 0, heldOffline: 0, needsAttention: [] };
    const quiet = renderToStaticMarkup(<RecoveryToast />);
    expect(quiet).toContain("Plisto finished an interrupted write");
    expect(quiet).toContain("Dismiss");
    expect(quiet).not.toContain("Show the file");

    held.report = { restored: 0, finished: 0, heldOffline: 0, needsAttention: ["a.opus"] };
    expect(renderToStaticMarkup(<RecoveryToast />)).toContain("Show the file");
  });
});
