// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server renderer reads a store's initial state, so the status hook is fed through the real model here.
vi.mock("../../../state/plugins/usePluginStatusView", async () => {
  const { statusView } = await import("../../../state/plugins/statusModel");
  return { usePluginStatusView: (r: PluginRow) => statusView("running", r, status({ host: "running" })) };
});

// The server renderer reads a store's initial state, so the sandbox outcome is fed in directly.
let probe: ProbeOutcome = "passed";
vi.mock("../../../state/plugins/sandboxStore", async (original) => ({
  ...(await original<typeof import("../../../state/plugins/sandboxStore")>()),
  useProbe: () => probe,
}));

// -- Unit Imports --
import { DevModeEntry } from "./DevModeEntry";
import { DevRowTools } from "./DevRowTools";
import { LogPanelView } from "./PluginLogPanel";
import { PluginRow as Row } from "./PluginRow";

// -- State Imports --
import { row, status } from "../../../state/plugins/fixtures";

// -- i18n Imports --
import { en } from "../../../i18n/en";

// -- Type Imports --
import type { ProbeOutcome } from "../../../state/plugins/trust";
import type { PluginRow } from "../../../types";

const rows = [row({ id: "lyrics" }), row({ id: "tandem", tier: "native" })];

const entry = (on: boolean, list: PluginRow[] = rows) =>
  renderToStaticMarkup(
    <DevModeEntry
      on={on}
      disabled={false}
      onToggle={() => {}}
      rows={list}
      logId={null}
      onSelectLog={() => {}}
      panelRef={null}
    />,
  );

const hubRow = (r: PluginRow, dev: boolean) =>
  renderToStaticMarkup(
    <Row
      row={r}
      busy={false}
      currentVersion={null}
      onToggle={() => {}}
      onReview={() => {}}
      onUninstall={() => {}}
      dev={dev ? { onReload: () => {}, onOpenLog: () => {} } : undefined}
    />,
  );

afterEach(() => {
  probe = "passed";
});

describe("developer mode switch", () => {
  it("is a quiet switch, off by default, that adds nothing else while off", () => {
    const html = entry(false);
    expect(html).toContain('data-setting-id="developerMode"');
    expect(html).toContain(en.plugins.devMode.label);
    expect(html).toContain(en.plugins.devMode.helper);
    expect(html).toContain(en.plugins.devMode.loopbackNote);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain(en.plugins.devMode.sandboxPassed);
    expect(html).not.toContain(en.plugins.devMode.sandboxNotPassed);
    expect(html).not.toContain(en.plugins.devMode.logLabel);
  });

  it("adds the sandbox check line and the log panel while on", () => {
    const html = entry(true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(en.plugins.devMode.sandboxPassed);
    expect(html).toContain(en.plugins.devMode.sandboxPassedBody);
    expect(html).toContain(en.plugins.devMode.logLabel);
  });

  it("says plainly when the sandbox check did not pass", () => {
    probe = "not_passed";
    const html = entry(true);
    expect(html).toContain(en.plugins.devMode.sandboxNotPassed);
    expect(html).toContain(en.plugins.devMode.sandboxNotPassedBody);
    expect(html).not.toContain(en.plugins.devMode.sandboxPassed);
  });

  it("shows no log panel when there is no plugin to read", () => {
    expect(entry(true, [])).not.toContain(en.plugins.devMode.logLabel);
  });
});

describe("developer mode row tools", () => {
  it("are hidden on a hub row while the switch is off", () => {
    const html = hubRow(row({ source_path: "C:/dev/lyrics" }), false);
    expect(html).not.toContain(en.plugins.devMode.reload);
    expect(html).not.toContain(en.plugins.devMode.openLog);
  });

  it("offer Reload and Open log on a row that remembers its source", () => {
    const html = hubRow(row({ source_path: "C:/dev/lyrics" }), true);
    expect(html).toContain(en.plugins.devMode.reload);
    expect(html).toContain(en.plugins.devMode.openLog);
  });

  it("offer no Reload on a row without a remembered source", () => {
    const html = hubRow(row({ source_path: null }), true);
    expect(html).not.toContain(en.plugins.devMode.reload);
    expect(html).toContain(en.plugins.devMode.openLog);
  });

  it("disable Reload while another operation runs", () => {
    const html = renderToStaticMarkup(
      <DevRowTools canReload busy onReload={() => {}} onOpenLog={() => {}} />,
    );
    expect(html).toMatch(/disabled=""[^>]*>[^<]*Reload from source/);
  });
});

describe("developer mode log panel", () => {
  const line = (text: string) => `1700000000000 INFO ${text}`;
  const panel = (view: Parameters<typeof LogPanelView>[0]["view"]) =>
    renderToStaticMarkup(<LogPanelView rows={rows} activeId="tandem" onSelect={() => {}} view={view} />);

  it("renders both logs for a native plugin", () => {
    const html = panel({ tail: { plugin: [line("started")], stderr: ["thread panicked"] }, failed: false });
    expect(html).toContain("started");
    expect(html).toContain("thread panicked");
    expect(html).toContain(en.plugins.devMode.logStderr);
  });

  it("renders only the plugin log for a UI plugin", () => {
    const html = panel({ tail: { plugin: [line("started")], stderr: null }, failed: false });
    expect(html).toContain("started");
    expect(html).not.toContain(en.plugins.devMode.logStderr);
  });

  it("names a tab for every installed plugin", () => {
    const html = panel({ tail: null, failed: false });
    expect(html).toContain(">Lyrics<");
    expect(html).toContain(en.plugins.devMode.logLoading);
  });

  it("says when a log is empty or could not be read", () => {
    expect(panel({ tail: { plugin: [], stderr: [] }, failed: false })).toContain(en.plugins.devMode.logEmpty);
    expect(panel({ tail: null, failed: true })).toContain(en.plugins.devMode.logFailed);
  });
});
