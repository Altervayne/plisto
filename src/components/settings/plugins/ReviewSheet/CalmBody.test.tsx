// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CalmBody } from "./CalmBody";
import { HeavyBody } from "./HeavyBody";
import { ReviewActions } from "./ReviewActions";
import { UnsandboxedBody } from "./UnsandboxedBody";
import { inspection, manifest, row } from "../../../../state/plugins/fixtures";
import { subjectFromInspection } from "../../../../state/plugins/review";

// -- i18n Imports --
import { en } from "../../../../i18n/en";
import { fr } from "../../../../i18n/fr";

// -- Type Imports --
import type { ReviewMode, ReviewSubject } from "../../../../state/plugins/review";
import type { PluginInspection, PluginRow } from "../../../../types";

const body = (subject: ReviewSubject, mode: ReviewMode = "install") =>
  renderToStaticMarkup(<CalmBody subject={subject} mode={mode} lead="adopted" />);
const foot = (subject: ReviewSubject, mode: ReviewMode) =>
  renderToStaticMarkup(
    <ReviewActions subject={subject} mode={mode} onConfirm={() => {}} onCancel={() => {}} />,
  );

const vis = (over: Partial<PluginInspection> = {}) =>
  inspection({
    id: "pulse",
    name: "Pulse Lab",
    capabilities: ["visualizer", "storage"],
    origins: [],
    listing: "catalog",
    ...over,
  });
const installed = (listing: "catalog" | "plugins", over: Partial<PluginRow> = {}) =>
  row({
    id: "pulse",
    granted: ["visualizer", "ui.sidebar", "storage"],
    manifest: manifest({ name: "Pulse Lab", listing, capabilities: ["visualizer", "ui.sidebar", "storage"] }),
    ...over,
  });

const flashNote =
  "Plisto does not check plugin visualizers for flashing. It stops one that stops responding. " +
  "You can have Plisto stop one that flashes in Settings, Visualizers.";

describe("the flash note on a visualizer plugin's sheet", () => {
  it("carries the fixed wording in English and French", () => {
    expect(en.plugins.vis.flashNote).toBe(flashNote);
    const [acute, circumflex] = [String.fromCharCode(233), String.fromCharCode(234)];
    const lead =
      `Plisto ne v${acute}rifie pas les flashs des visualiseurs de plugins. ` +
      `Il arr${circumflex}te celui qui ne r${acute}pond plus.`;
    expect(fr.plugins.vis.flashNote.startsWith(lead)).toBe(true);
  });

  it("shows on the sheet of a plugin that draws visualizers, and not on any other", () => {
    expect(body(subjectFromInspection(vis()))).toContain(flashNote);
    expect(body(subjectFromInspection(inspection()))).not.toContain("check plugin visualizers");
  });
});

describe("the flash note on the other sheet variants", () => {
  const subject = () => subjectFromInspection(vis());

  it("shows on the unsandboxed sheet of a visualizer-only plugin, with its listing line", () => {
    const html = renderToStaticMarkup(<UnsandboxedBody subject={subject()} mode="install" lead="adopted" />);
    expect(html).toContain(flashNote);
    expect(html).toContain(en.plugins.vis.listedVisualizers);
  });

  it("shows on the heavy sheet, and not for a plugin with no visualizers", () => {
    const html = renderToStaticMarkup(<HeavyBody subject={subject()} mode="install" lead="adopted" />);
    expect(html).toContain(flashNote);
    const plain = subjectFromInspection(inspection());
    const out = renderToStaticMarkup(<HeavyBody subject={plain} mode="install" lead="adopted" />);
    expect(out).not.toContain(flashNote);
  });
});

describe("the listing line of an install", () => {
  it("says a visualizer-only plugin will be listed in Visualizers", () => {
    expect(body(subjectFromInspection(vis()))).toContain(en.plugins.vis.listedVisualizers);
  });

  it("says a plugin with its own page will be listed in Plugins, its visualizers in Visualizers", () => {
    const html = body(subjectFromInspection(vis({ listing: "plugins" })));
    expect(html).toContain(en.plugins.vis.listedPlugins);
    expect(html).not.toContain(en.plugins.vis.listedVisualizers);
  });

  it("is left out for a plugin with no visualizers", () => {
    const html = body(subjectFromInspection(inspection()));
    expect(html).not.toContain(en.plugins.vis.listedPlugins);
    expect(html).not.toContain(en.plugins.vis.listedVisualizers);
  });
});

describe("the update lines", () => {
  const toCatalog = () => subjectFromInspection(vis({ installed: "1.0.0" }), installed("plugins"));
  const toPlugins = () =>
    subjectFromInspection(
      vis({ installed: "1.0.0", listing: "plugins", capabilities: ["visualizer", "ui.sidebar"] }),
      installed("catalog"),
    );

  it("says an update moves a plugin to Plugins", () => {
    const html = body(toPlugins(), "update");
    expect(html).toContain(en.plugins.vis.movesToPlugins);
    expect(html).not.toContain(en.plugins.vis.listedPlugins);
  });

  it("says an update moves a plugin to Visualizers, and lists what it no longer needs", () => {
    const html = body(toCatalog(), "update");
    expect(html).toContain(en.plugins.vis.movesToVisualizers);
    expect(html).toContain(en.plugins.vis.capsRemoved);
    expect(html).toContain(en.plugins.capability["ui.sidebar"]);
  });

  it("says nothing about listing when an update stays where it is", () => {
    const stay = subjectFromInspection(vis({ installed: "1.0.0" }), installed("catalog"));
    const html = body(stay, "update");
    expect(html).not.toContain(en.plugins.vis.movesToPlugins);
    expect(html).not.toContain(en.plugins.vis.movesToVisualizers);
  });
});

describe("the sheet's footer", () => {
  it("says a visualizer-only plugin is installed turned on", () => {
    expect(foot(subjectFromInspection(vis()), "install")).toContain(en.plugins.vis.landsOn);
  });

  it("keeps the turned-off note for a plugin with its own page", () => {
    const html = foot(subjectFromInspection(vis({ listing: "plugins" })), "install");
    expect(html).toContain(en.plugins.sheet.offNote);
    expect(html).not.toContain(en.plugins.vis.landsOn);
  });

  it("keeps the permissions warning on every update, and adds the keeps line only on a move", () => {
    const stays = subjectFromInspection(vis({ installed: "1.0.0" }), installed("catalog"));
    expect(foot(stays, "update")).toContain(en.plugins.sheet.updateNote);
    expect(foot(stays, "update")).not.toContain(en.plugins.vis.updateKeeps);
    const moves = subjectFromInspection(vis({ installed: "1.0.0" }), installed("plugins"));
    expect(foot(moves, "update")).toContain(en.plugins.sheet.updateNote);
    expect(foot(moves, "update")).toContain(en.plugins.vis.updateKeeps);
  });

  it("leaves the update sheet of a plugin without visualizers as it was", () => {
    const plain = subjectFromInspection(inspection({ installed: "1.3.0", capabilities: ["network"] }), row());
    expect(body(plain, "update")).not.toContain(en.plugins.vis.capsRemoved);
  });
});
