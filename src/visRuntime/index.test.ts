import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MINE, fakeCanvas, fakeGl, testCandidate, testInit } from "./fixtures";
import { isShaderPage } from "./shaderHost";

import type { VisInit } from "./protocol";

interface FakePort {
  sent: unknown[];
  closed: boolean;
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (m: unknown) => void;
  close: () => void;
}

function fakePort(): FakePort {
  const port: FakePort = {
    sent: [],
    closed: false,
    onmessage: null,
    postMessage: (m) => port.sent.push(m),
    close: () => {
      port.closed = true;
    },
  };
  return port;
}

/** Loads a fresh runtime into a stand-in page and returns it with the page's canvases and window listener. */
async function loadRuntime() {
  const stage: unknown[] = [];
  const parent = { postMessage: () => {} };
  let listener: (e: unknown) => void = () => {};
  const { gl, state } = fakeGl([]);
  state.complete = () => true;
  vi.stubGlobal("window", {
    parent,
    devicePixelRatio: 1,
    addEventListener: (_type: string, fn: (e: unknown) => void) => {
      listener = fn;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vi.stubGlobal("location", { pathname: "/kinds/mine.html", href: "https://plugin.localhost/kinds/mine.html" });
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, appendChild: (c: unknown) => stage.push(c) },
    createElement: () => fakeCanvas(gl, stage).canvas,
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.resetModules();
  const vis = await import("./index");
  const init = (port: FakePort, over: Partial<VisInit> = {}) =>
    listener({ source: parent, data: { ...testInit(), ...over }, ports: [port] });
  return { vis, stage, init };
}

describe("the runtime's init handling", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces an earlier mount with a later init, leaving one canvas", async () => {
    const { vis, stage, init } = await loadRuntime();
    vis.candidate(testCandidate({ on: false }), { programs: [MINE] });
    const first = fakePort();
    init(first);
    expect(stage.length).toBe(1);
    const second = fakePort();
    init(second);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(stage.length).toBe(1);
  });

  it("closes a waiting port when a later init arrives before the kind registers", async () => {
    const { vis, stage, init } = await loadRuntime();
    const first = fakePort();
    const second = fakePort();
    init(first);
    init(second);
    expect(first.closed).toBe(true);
    vis.candidate(testCandidate({ on: false }), { programs: [MINE] });
    expect(stage.length).toBe(1);
    expect(second.closed).toBe(false);
  });

  it("answers an init for another api with an error and closes its port", async () => {
    const { init } = await loadRuntime();
    const port = fakePort();
    init(port, { api: 2 } as Partial<VisInit>);
    expect(port.sent).toEqual([{ type: "error", stage: "setup", message: "runtime api 1 cannot serve api 2" }]);
    expect(port.closed).toBe(true);
  });

  it("closes the port when the kind fails to mount", async () => {
    const { vis, init } = await loadRuntime();
    vis.raw({
      frame: () => {},
      setup: () => {
        throw new Error("no setup");
      },
    });
    const port = fakePort();
    init(port);
    expect(port.sent).toEqual([{ type: "error", stage: "setup", message: "no setup" }]);
    expect(port.closed).toBe(true);
  });

  it("exposes no channel until the host relays one", async () => {
    const { vis } = await loadRuntime();
    expect("channel" in vis).toBe(false);
  });
});

describe("the shader page", () => {
  it("is recognized by its exact path only", () => {
    expect(isShaderPage("/_plisto/vis/1/shader.html")).toBe(true);
    expect(isShaderPage("/kinds/shader.html")).toBe(false);
    expect(isShaderPage("/_plisto/vis/1/shader.html/x")).toBe(false);
    expect(isShaderPage("/x/_plisto/vis/1/shader.html")).toBe(false);
  });
});
