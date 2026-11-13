/*
 * Version order for the update sheet. Compares the numeric core of two dotted versions and ranks a
 * pre-release below its release; anything it cannot read compares as unknown so the sheet says nothing
 * rather than guess.
 */

/** How a new version stands against the installed one. */
export type VersionChange = "upgrade" | "downgrade" | "same" | "unknown";

function core(version: string): { nums: number[]; pre: boolean } | null {
  const [main, pre] = version.trim().split("-", 2);
  const parts = main.split(".");
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return { nums: parts.map(Number), pre: pre !== undefined };
}

export function versionChange(installed: string, next: string): VersionChange {
  const a = core(installed);
  const b = core(next);
  if (!a || !b) return "unknown";
  const len = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < len; i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return y > x ? "upgrade" : "downgrade";
  }
  if (a.pre === b.pre) return "same";
  return b.pre ? "downgrade" : "upgrade";
}
