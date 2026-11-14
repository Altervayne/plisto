// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { TakeoverNotice } from "./TakeoverNotice";

// -- i18n Imports --
import { createT } from "../../i18n";
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

vi.mock("../../lib/ipc", () => ({ pluginTakeoverRelease: vi.fn() }));

const render = (view: Parameters<typeof TakeoverNotice>[0]["view"], busy = false) =>
  renderToStaticMarkup(<TakeoverNotice view={view} busy={busy} onReturn={() => {}} />);

describe("TakeoverNotice", () => {
  it("held: Plisto's sentence, the plugin's report beneath it, and the Return button", () => {
    const html = render({ kind: "held", id: "t", name: "Tandem", text: "Mirroring to 3 devices" });
    expect(html).toContain("Tandem is playing your music elsewhere. Plisto&#x27;s own output is muted while it does.");
    expect(html).toContain("Mirroring to 3 devices");
    expect(html).toContain("Return to Plisto&#x27;s speakers");
    expect(html).not.toContain("disabled");
  });

  it("held: no second line without a report, and the plugin text never sits in Plisto's sentence", () => {
    const html = render({ kind: "held", id: "t", name: "Tandem", text: null });
    expect(html).not.toContain("report");
    const withText = render({ kind: "held", id: "t", name: "Tandem", text: "hello" });
    expect(withText.indexOf("while it does.")).toBeLessThan(withText.indexOf("hello"));
  });

  it("held without a known holder reads without a name and keeps the button", () => {
    const html = render({ kind: "held", id: "t", name: null, text: null });
    expect(html).toContain("A plugin is playing your music elsewhere.");
    expect(html).toContain("Return to Plisto");
  });

  it("disables the button while a release is in flight", () => {
    expect(render({ kind: "held", id: "t", name: "Tandem", text: null }, true)).toContain("disabled");
  });

  it("not responding: the amber line and no button", () => {
    const html = render({ kind: "notResponding", name: "Tandem" });
    expect(html).toContain("Tandem is not responding. Plisto&#x27;s own speakers are playing again.");
    expect(html).not.toContain("<button");
  });

  it("escapes a hostile plugin name and report as text", () => {
    const html = render({ kind: "held", id: "t", name: "<b>x</b>", text: "<i>y</i>" });
    expect(html).not.toContain("<b>x");
    expect(html).not.toContain("<i>y");
  });
});

describe("takeover strings", () => {
  it("exist in both locales", () => {
    const keys = Object.keys(en.sound).filter((k) => k.startsWith("takeover"));
    expect(keys.length).toBe(4);
    for (const key of keys) {
      expect((fr.sound as unknown as Record<string, string>)[key]).toBeTruthy();
    }
  });

  it("French main line matches the owner's wording", () => {
    const t = createT("fr");
    expect(t((d) => d.sound.takeoverHeld, { name: "Tandem" })).toBe(
      "Tandem diffuse votre musique ailleurs. La sortie de Plisto est coupée pendant ce temps.",
    );
  });
});
