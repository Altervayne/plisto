// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { FileWritesHost } from "./FileWritesHost";

// -- Type Imports --
import type { FileWritesSheet } from "../../state/fileWrites/store";

// The static renderer reads a zustand store at its initial state, so the open sheet is fed through a stand-in.
const held = vi.hoisted(() => ({ sheet: null as FileWritesSheet | null }));
vi.mock("../../state/fileWrites/store", () => ({
  useFileWritesSheet: () => held.sheet,
  useCloseFileWritesSheet: () => () => {},
}));
vi.mock("./useWriteRecovery", () => ({ useWriteRecovery: () => {} }));
vi.mock("./RecoveryToast", () => ({ RecoveryToast: () => null }));
vi.mock("./BusyToast", () => ({ BusyToast: () => null }));
vi.mock("./StampSheet", () => ({ StampSheet: () => <i>stamp</i> }));
vi.mock("./KeptBackupsSheet", () => ({ KeptBackupsSheet: () => <i>kept</i> }));

beforeEach(() => {
  held.sheet = null;
});

describe("FileWritesHost", () => {
  it("mounts no sheet while none is open", () => {
    expect(renderToStaticMarkup(<FileWritesHost />)).toBe("");
  });

  it("mounts the sheet the store holds open", () => {
    held.sheet = { kind: "stamp", scope: { kind: "library" } };
    expect(renderToStaticMarkup(<FileWritesHost />)).toBe("<i>stamp</i>");
    held.sheet = { kind: "kept" };
    expect(renderToStaticMarkup(<FileWritesHost />)).toBe("<i>kept</i>");
  });
});
