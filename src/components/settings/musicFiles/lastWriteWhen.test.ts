import { describe, expect, it } from "vitest";

import { lastWriteWhen } from "./lastWriteWhen";

const words = { today: (t: string) => `today ${t}`, yesterday: (t: string) => `yesterday ${t}` };
const now = new Date(2026, 10, 20, 16, 0).getTime();

describe("lastWriteWhen", () => {
  it("words a write from today and yesterday with its clock time", () => {
    expect(lastWriteWhen(new Date(2026, 10, 20, 14, 32).getTime(), now, "en", words)).toBe("today 14:32");
    expect(lastWriteWhen(new Date(2026, 10, 19, 9, 5).getTime(), now, "en", words)).toBe("yesterday 09:05");
  });

  it("gives an older write its date", () => {
    const text = lastWriteWhen(new Date(2026, 10, 10, 9, 5).getTime(), now, "en", words);
    expect(text).not.toContain("today");
    expect(text).not.toContain("yesterday");
  });
});
