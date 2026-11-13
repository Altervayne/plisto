// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  afterUpdate,
  canConfirm,
  consentCommand,
  enableArgs,
  hasNewCapabilities,
  isNewCapability,
  isNewOrigin,
  needsTick,
  reopensReview,
  subjectFromInspection,
  subjectFromRow,
  updateChange,
  variantOf,
} from "./review";
import { fileNameOf } from "./sheet";
import { inspection, manifest, row } from "./fixtures";

describe("the subject of a review", () => {
  it("comes from an inspection, with capabilities in sheet order", () => {
    const subject = subjectFromInspection(inspection());
    expect(subject.capabilities).toEqual(["playback.read", "library.read", "network"]);
    expect(subject.previous).toBeNull();
  });

  it("comes from an installed row's manifest, and is absent when the manifest is unreadable", () => {
    expect(subjectFromRow(row())?.name).toBe("Lyrics");
    expect(subjectFromRow(row({ manifest: null }))).toBeNull();
  });

  it("records what an installed ready plugin was approved for", () => {
    const subject = subjectFromInspection(inspection({ installed: "1.3.0" }), row());
    expect(subject.previous).toEqual({
      version: "1.3.0",
      capabilities: ["playback.read", "network"],
      origins: ["lyrics.example.com"],
    });
  });

  it("records no approval for an installed plugin that was never approved", () => {
    const pending = row({ state: "needs_consent", enabled: false, granted: [] });
    const subject = subjectFromInspection(inspection({ installed: "" }), pending);
    expect(subject.previous?.capabilities).toBeNull();
    expect(subject.previous?.version).toBe("1.3.0");
  });
});

describe("which sheet", () => {
  it("is calm for a sandboxed plugin and heavy for a native one", () => {
    expect(variantOf(subjectFromInspection(inspection()))).toBe("calm");
    expect(variantOf(subjectFromInspection(inspection({ tier: "native" })))).toBe("heavy");
  });
});

describe("the tick before confirming", () => {
  const native = subjectFromInspection(inspection({ tier: "native", native_reason: "Needs devices." }));
  const calm = subjectFromInspection(inspection());

  it("is required to install or approve a native plugin", () => {
    expect(needsTick(native, "install")).toBe(true);
    expect(needsTick(native, "consent")).toBe(true);
    expect(canConfirm(native, "install", false, false)).toBe(false);
    expect(canConfirm(native, "install", true, false)).toBe(true);
    expect(canConfirm(native, "consent", false, false)).toBe(false);
  });

  it("is not required for a plain update, which does not turn anything on", () => {
    expect(needsTick(native, "update")).toBe(false);
    expect(canConfirm(native, "update", false, false)).toBe(true);
  });

  it("is not required on the calm sheet", () => {
    expect(canConfirm(calm, "install", false, false)).toBe(true);
  });

  it("never confirms while a command runs or for a plugin this Plisto cannot run", () => {
    expect(canConfirm(calm, "install", true, true)).toBe(false);
    const newer = subjectFromInspection(inspection({ compat: { state: "needs_newer", min_plisto: "9.0.0" } }));
    expect(canConfirm(newer, "install", true, false)).toBe(false);
  });
});

describe("what is new in an update", () => {
  const subject = subjectFromInspection(inspection({ installed: "1.3.0" }), row());

  it("marks a capability the approved version lacked", () => {
    expect(isNewCapability(subject, "library.read")).toBe(true);
    expect(isNewCapability(subject, "playback.read")).toBe(false);
    expect(hasNewCapabilities(subject)).toBe(true);
  });

  it("marks the network line and the origin when a new site is declared", () => {
    expect(isNewCapability(subject, "network")).toBe(true);
    expect(isNewOrigin(subject, "notes.example.com")).toBe(true);
    expect(isNewOrigin(subject, "lyrics.example.com")).toBe(false);
  });

  it("marks nothing for a fresh install or when nothing was approved", () => {
    const fresh = subjectFromInspection(inspection());
    expect(hasNewCapabilities(fresh)).toBe(false);
    const unapproved = subjectFromInspection(
      inspection({ installed: "1.3.0" }),
      row({ state: "needs_consent", granted: [] }),
    );
    expect(hasNewCapabilities(unapproved)).toBe(false);
  });

  it("says a downgrade plainly", () => {
    const older = subjectFromInspection(inspection({ version: "1.2.0", installed: "1.3.0" }), row());
    expect(updateChange(older)).toBe("downgrade");
    expect(updateChange(subject)).toBe("upgrade");
  });
});

describe("the flow decisions", () => {
  it("enables with exactly the manifest's capabilities and the hash the sheet was built from", () => {
    const subject = subjectFromRow(row({ manifest: manifest({ capabilities: ["network", "storage"] }) }))!;
    expect(enableArgs(subject, "hash-9", true)).toEqual({
      id: "lyrics",
      grants: ["storage", "network"],
      nativeAck: undefined,
      manifestHash: "hash-9",
    });
  });

  it("passes the acknowledgement only for a native plugin", () => {
    const native = subjectFromInspection(inspection({ tier: "native" }));
    expect(enableArgs(native, "h", true).nativeAck).toBe(true);
    expect(enableArgs(native, "h", false).nativeAck).toBe(false);
  });

  it("ends an install in approve, not enable, and a review of an installed plugin in enable", () => {
    expect(consentCommand("install")).toBe("approve");
    expect(consentCommand("consent")).toBe("enable");
    expect(consentCommand("update")).toBeNull();
  });

  it("grants a capability this Plisto does not know unchanged", () => {
    const m = manifest({ capabilities: ["storage", "future.thing" as never] });
    const subject = subjectFromRow(row({ manifest: m }))!;
    expect(enableArgs(subject, "h", false).grants).toEqual(["storage", "future.thing"]);
  });

  it("goes straight to a permission review when an update comes back needing consent", () => {
    expect(afterUpdate({ row: row({ state: "needs_consent" }), previous_version: "1.3.0" })).toBe("consent");
    expect(afterUpdate({ row: row(), previous_version: "1.3.0" })).toBe("done");
  });

  it("reopens the review on a manifest that changed or a plugin that was busy, and no other refusal", () => {
    expect(reopensReview("manifest_changed")).toBe(true);
    expect(reopensReview("busy")).toBe(true);
    expect(reopensReview("incompatible")).toBe(false);
    expect(reopensReview("unknown")).toBe(false);
  });
});

describe("fileNameOf", () => {
  it("takes the last segment of either separator", () => {
    expect(fileNameOf("C:\\plugins\\lyrics.plistoplugin")).toBe("lyrics.plistoplugin");
    expect(fileNameOf("/home/me/lyrics/")).toBe("lyrics");
  });
});
