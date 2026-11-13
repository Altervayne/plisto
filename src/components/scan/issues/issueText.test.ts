// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  PREVIEW_LINES,
  REASON_ORDER,
  checkedJustNow,
  copyPreview,
  reasonHint,
  reasonLabel,
  shortenPath,
  splitPath,
  standingTotal,
  visibleChips,
} from "./issueText";

// -- Type Imports --
import type { ScanIssueReason } from "../../../types";

// -- i18n Imports --
import { createT } from "../../../i18n";
import { en } from "../../../i18n/en";
import { fr } from "../../../i18n/fr";

describe("shortenPath", () => {
  it("leaves a short path alone", () => {
    expect(shortenPath("D:\\Music\\Rips")).toBe("D:\\Music\\Rips");
  });

  it("cuts the middle and keeps the head and the end of the last folder", () => {
    const path = `D:\\Music\\${"Archives\\".repeat(12)}Sigur Ros - Agaetis byrjun`;
    const short = shortenPath(path, 40);
    expect(short).toHaveLength(40);
    expect(short.startsWith("D:\\Music\\Archives")).toBe(true);
    expect(short.endsWith("Agaetis byrjun")).toBe(true);
    expect(short).toContain("...");
  });

  it("holds the cap at a path exactly as long", () => {
    expect(shortenPath("x".repeat(70), 70)).toBe("x".repeat(70));
    expect(shortenPath("x".repeat(71), 70)).toHaveLength(70);
  });
});

describe("splitPath", () => {
  it("splits a Windows path into name and folder", () => {
    expect(splitPath("D:\\Music\\Rips\\03 - Exit.flac")).toEqual({
      name: "03 - Exit.flac",
      dir: "D:\\Music\\Rips",
    });
  });

  it("splits a forward-slash path and ignores a trailing separator on a folder", () => {
    expect(splitPath("/music/Archives/Private/")).toEqual({ name: "Private", dir: "/music/Archives" });
  });

  it("trims a trailing backslash on a Windows folder", () => {
    expect(splitPath("D:\\Music\\Private\\")).toEqual({ name: "Private", dir: "D:\\Music" });
  });

  it("keeps a bare name whole", () => {
    expect(splitPath("track.mp3")).toEqual({ name: "track.mp3", dir: "" });
  });
});

describe("visibleChips", () => {
  it("is empty with no reason or one reason, since there is nothing to filter", () => {
    expect(visibleChips({})).toEqual([]);
    expect(visibleChips({ in_use: 12 })).toEqual([]);
  });

  it("lists the present reasons in the fixed order with their counts", () => {
    expect(visibleChips({ other: 1, access_denied: 4, corrupt_or_unsupported: 9 })).toEqual([
      { reason: "access_denied", n: 4 },
      { reason: "corrupt_or_unsupported", n: 9 },
      { reason: "other", n: 1 },
    ]);
  });

  it("skips a reason counted at zero", () => {
    expect(visibleChips({ in_use: 0, other: 2, disk_error: 3 })).toEqual([
      { reason: "disk_error", n: 3 },
      { reason: "other", n: 2 },
    ]);
  });

  it("sums the standing total across reasons", () => {
    expect(standingTotal({ in_use: 2, other: 5 })).toBe(7);
    expect(standingTotal({})).toBe(0);
  });
});

describe("a reason code this build does not know", () => {
  const unknown = "from_the_future" as ScanIssueReason;

  it("reads as the could-not-be-read label and hint", () => {
    const t = createT("en");
    expect(reasonLabel(t, unknown)).toBe(en.scan.issueReasonOther);
    expect(reasonHint(t, unknown)).toBe(en.scan.issueHintOther);
  });

  it("is counted in the total and folded into the other chip", () => {
    expect(standingTotal({ in_use: 2, other: 1, [unknown]: 3 })).toBe(6);
    expect(visibleChips({ in_use: 2, [unknown]: 3 })).toEqual([
      { reason: "in_use", n: 2 },
      { reason: "other", n: 3 },
    ]);
  });
});

describe("copyPreview", () => {
  const text = (n: number) =>
    `Plisto scan issues: ${n}\n${Array.from({ length: n }, (_, i) => `other\tD:\\m\\${i}.mp3\tboom`).join("\n")}\n`;

  it("shows every line of a short list and nothing more", () => {
    const p = copyPreview(text(3));
    expect(p.header).toBe("Plisto scan issues: 3");
    expect(p.lines).toHaveLength(3);
    expect(p.more).toBe(0);
  });

  it("previews 15 lines and counts the rest", () => {
    const p = copyPreview(text(2400));
    expect(PREVIEW_LINES).toBe(15);
    expect(p.lines).toHaveLength(15);
    expect(p.more).toBe(2385);
  });

  it("shows exactly 15 lines without a more line", () => {
    const p = copyPreview(text(15));
    expect(p.lines).toHaveLength(15);
    expect(p.more).toBe(0);
  });

  it("copes with an empty text", () => {
    expect(copyPreview("")).toEqual({ header: "", lines: [], more: 0 });
  });
});

describe("checkedJustNow", () => {
  it("is true within two minutes and false after", () => {
    expect(checkedJustNow(1000, 1060)).toBe(true);
    expect(checkedJustNow(1000, 1200)).toBe(false);
  });
});

describe("reason wording", () => {
  it("words all six reasons and their next steps in both locales", () => {
    for (const locale of ["en", "fr"] as const) {
      const t = createT(locale);
      const labels = REASON_ORDER.map((r) => reasonLabel(t, r));
      const hints = REASON_ORDER.map((r) => reasonHint(t, r));
      expect(REASON_ORDER).toHaveLength(6);
      expect(new Set(labels).size).toBe(6);
      expect(new Set(hints).size).toBe(6);
      for (const text of [...labels, ...hints]) expect(text.length).toBeGreaterThan(3);
    }
  });

  it("reads the mockup's words", () => {
    const t = createT("en");
    expect(reasonLabel(t, "access_denied")).toBe("Access denied");
    expect(reasonLabel(t, "corrupt_or_unsupported")).toBe("Damaged or unsupported file");
    expect(reasonHint(t, "in_use")).toBe("Close the other program, then retry.");
    const fr = createT("fr");
    expect(reasonLabel(fr, "path_too_long")).toBe("Chemin trop long");
    expect(reasonHint(fr, "other")).toBe("Voir le détail ci-dessous.");
  });
});

// The leaf keys under `scan`, flattened, with each leaf's {{slot}} names.
function leaves(node: unknown, prefix = ""): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (typeof node === "string") {
    out.set(prefix, [...node.matchAll(/\{\{?(\w+)\}?\}/g)].map((m) => m[1]).sort());
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      for (const [k, v] of leaves(value, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  }
  return out;
}

describe("scan strings in both locales", () => {
  const enScan = leaves(en.scan);
  const frScan = leaves(fr.scan);

  it("holds the same keys", () => {
    expect([...frScan.keys()].sort()).toEqual([...enScan.keys()].sort());
  });

  it("holds the same slots in each string", () => {
    for (const [key, slots] of enScan) expect(frScan.get(key), key).toEqual(slots);
  });
});
