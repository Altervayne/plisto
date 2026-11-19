// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { StatBox } from "./StatBox";

const render = (count: number | null) =>
  renderToStaticMarkup(
    <StatBox label="Unsorted" count={count} verb="to sort" settled="All sorted" onClick={() => {}} />,
  );

describe("StatBox", () => {
  it("shows the label alone when the count is not known", () => {
    const html = render(null);
    expect(html).toContain("Unsorted");
    expect(html).not.toContain("to sort");
    expect(html).not.toContain("All sorted");
    expect(html).not.toContain(">0<");
  });

  it("settles at zero and shows the verb above it", () => {
    expect(render(0)).toContain("All sorted");
    expect(render(4)).toContain("to sort");
  });
});
