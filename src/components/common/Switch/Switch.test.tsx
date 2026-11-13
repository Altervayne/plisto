// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Framework Imports --
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// -- Component Imports --
import { Switch } from "./Switch";
import { ExportSections } from "../../export/ExportSections";

// -- Type Imports --
import type { ReactElement } from "react";

type Button = ReactElement<{ onClick: () => void; disabled: boolean; "aria-checked": boolean; "aria-busy"?: string }>;

/** The switch is a hookless component, so its element tree reads straight off the call. */
const button = (props: Partial<Parameters<typeof Switch>[0]> = {}): Button =>
  Switch({ checked: false, onChange: () => {}, label: "Mirroring", ...props }) as Button;

describe("Switch", () => {
  it("flips the value it was given", () => {
    const onChange = vi.fn();
    button({ checked: false, onChange }).props.onClick();
    button({ checked: true, onChange }).props.onClick();
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("is a labelled switch and takes disabled through", () => {
    const html = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: () => {}, label: "Mirroring", disabled: true }));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Mirroring"');
    expect(html).toContain("disabled");
  });
});

describe("Switch pending", () => {
  it("is busy, not disabled, and ignores the press", () => {
    const onChange = vi.fn();
    const el = button({ checked: false, onChange, pending: true });
    el.props.onClick();
    expect(onChange).not.toHaveBeenCalled();
    expect(el.props["aria-busy"]).toBe("true");
    expect(el.props.disabled).toBe(false);
  });

  it("leaves the knob state and the busy mark off when not pending", () => {
    const el = button({ checked: true });
    expect(el.props["aria-busy"]).toBeUndefined();
    expect(el.props["aria-checked"]).toBe(true);
  });
});

describe("ExportSections after the switch extraction", () => {
  const render = (playlists: boolean) =>
    renderToStaticMarkup(
      createElement(ExportSections, {
        albums: true,
        singles: false,
        playlists,
        shape: "mimic",
        onToggle: () => {},
        onShape: () => {},
      }),
    );

  it("still draws one switch per section, each in its own state", () => {
    const html = render(false);
    const states = [...html.matchAll(/role="switch" aria-checked="(true|false)"/g)].map((m) => m[1]);
    expect(states).toEqual(["true", "false", "false"]);
    expect(html).not.toContain("disabled");
  });

  it("shows the shape choice only with Playlists on", () => {
    expect(render(false)).not.toContain('aria-label="Playlist shape"');
    expect(render(true)).toContain('aria-label="Playlist shape"');
  });
});
