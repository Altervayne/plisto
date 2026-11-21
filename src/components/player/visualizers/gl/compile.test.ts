import { describe, expect, it } from "vitest";

import { deferredCompile, pollProgram, syncCompile } from "./compile";
import { createKit, ProgramPending } from "./kit";

const SRC = { name: "p", vs: "vs", fs: "fs" };

/** A GL stand-in that logs every call and lets a test script link completion and failure. */
function fakeGl(opts: { ext: boolean; linkOk?: boolean; badShader?: number }) {
  const calls: string[] = [];
  const state = { complete: false };
  const ext = { COMPLETION_STATUS_KHR: 0x91b1 };
  const gl = new Proxy(
    {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      ARRAY_BUFFER: 5,
      STATIC_DRAW: 6,
      FLOAT: 7,
      getExtension: (n: string) => {
        calls.push(`getExtension:${n}`);
        if (n === "KHR_parallel_shader_compile") return opts.ext ? ext : null;
        return null;
      },
      getShaderParameter: (s: { args: unknown[] }) => {
        calls.push("getShaderParameter");
        return s.args[0] !== opts.badShader;
      },
      getProgramParameter: (_p: unknown, k: number) => {
        calls.push(`getProgramParameter:${k}`);
        return k === ext.COMPLETION_STATUS_KHR ? state.complete : (opts.linkOk ?? true);
      },
      getProgramInfoLog: () => "link log",
      getShaderInfoLog: (s: { args: unknown[] }) => `shader log ${String(s.args[0])}`,
    } as Record<string, unknown>,
    {
      get(target, key: string) {
        if (key in target) return target[key];
        return (...args: unknown[]) => {
          calls.push(key);
          return key.startsWith("create") ? { id: key, args } : undefined;
        };
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, calls, state };
}

describe("deferredCompile", () => {
  it("submits without any status query, then polls and surfaces a link error with its log", () => {
    const { gl, calls, state } = fakeGl({ ext: true, linkOk: false });
    const p = deferredCompile(gl, "vs", "fs");
    expect(calls).toContain("linkProgram");
    expect(calls.some((c) => c.startsWith("getProgramParameter") || c === "getShaderParameter")).toBe(false);
    expect(pollProgram(gl, p)).toBe(false);
    state.complete = true;
    expect(() => pollProgram(gl, p)).toThrow("link log");
  });

  it("surfaces a failing fragment shader's own log, prefixed", () => {
    const { gl, state } = fakeGl({ ext: true, linkOk: false, badShader: 2 });
    const p = deferredCompile(gl, "vs", "fs");
    state.complete = true;
    expect(() => pollProgram(gl, p)).toThrow("fragment: shader log 2");
  });

  it("counts as complete on the next poll without the extension", () => {
    const { gl } = fakeGl({ ext: false });
    expect(pollProgram(gl, deferredCompile(gl, "vs", "fs"))).toBe(true);
  });
});

describe("kit with a deferred compiler", () => {
  it("raises the pending signal until the program completes, and lists it", () => {
    const { gl, state } = fakeGl({ ext: true });
    const kit = createKit(gl, deferredCompile);
    expect(() => kit.program(SRC)).toThrow(ProgramPending);
    expect(kit.pending()).toEqual(["p"]);
    expect(() => kit.program(SRC)).toThrow(ProgramPending);
    state.complete = true;
    expect(kit.program(SRC).handle).toBeTruthy();
    expect(kit.pending()).toEqual([]);
  });

  it("throws the link log from pending and lets a later call resubmit", () => {
    const { gl, state } = fakeGl({ ext: true, linkOk: false });
    const kit = createKit(gl, deferredCompile);
    expect(() => kit.program(SRC)).toThrow(ProgramPending);
    state.complete = true;
    expect(() => kit.pending()).toThrow("link log");
    expect(() => kit.program(SRC)).toThrow(ProgramPending);
  });
});

describe("syncCompile", () => {
  it("queries status at once and returns the program", () => {
    const { gl, calls } = fakeGl({ ext: false });
    syncCompile(gl, "vs", "fs");
    expect(calls.filter((c) => c === "getShaderParameter")).toHaveLength(2);
    expect(calls).toContain("getProgramParameter:4");
    expect(calls.indexOf("linkProgram")).toBeLessThan(calls.indexOf("getProgramParameter:4"));
  });

  it("throws the link log on failure and the kit default matches", () => {
    const { gl } = fakeGl({ ext: false, linkOk: false });
    expect(() => syncCompile(gl, "vs", "fs")).toThrow("link log");
    expect(() => createKit(gl).program(SRC)).toThrow("link log");
  });
});
