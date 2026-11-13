// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { INSTALL_ERROR_CODES, readInstallError } from "./errors";
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

describe("install error messages", () => {
  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("has a message for every code in %s", (_name, dict) => {
    const messages = dict.plugins.errors as Record<string, string>;
    for (const code of INSTALL_ERROR_CODES) {
      expect(messages[code], code).toBeTruthy();
    }
    expect(messages.unknown).toBeTruthy();
  });

  it("lists exactly the codes the backend defines", () => {
    expect(INSTALL_ERROR_CODES).toHaveLength(24);
  });
});

describe("readInstallError", () => {
  it("reads a known code and its detail", () => {
    expect(readInstallError({ code: "tier_changed", detail: "x" })).toEqual({
      key: "tier_changed",
      detail: "x",
    });
  });

  it("reads an unknown code, a bare string and a thrown Error as unknown", () => {
    expect(readInstallError({ code: "brand_new", detail: "d" }).key).toBe("unknown");
    expect(readInstallError("boom").key).toBe("unknown");
    expect(readInstallError(new Error("boom")).key).toBe("unknown");
  });

  it("does not trust an inherited property name as a code", () => {
    expect(readInstallError({ code: "toString" }).key).toBe("unknown");
  });
});
