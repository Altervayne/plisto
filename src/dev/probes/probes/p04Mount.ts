/*
 * P4: time from inserting a visualizer frame to its first drawn frame, with the real Lake and shared
 * programs as the workload. Each run salts every source with a unique comment line right after its
 * #version line, so a program cache keyed on the source text cannot answer a cold compile; one pair of
 * unsalted runs is reported to show whether such a cache exists. The reference is the same salted
 * compile in a fresh context of the main document. The sources are imported read-only and posted as data.
 */

// -- Local Imports --
import { LAKE_PROGRAMS } from "../../../components/player/visualizers/gl/lake";
import { SHARED_PROGRAMS } from "../../../components/player/visualizers/gl/shaders";
import { probeMemory, probeProcesses } from "../ipc";
import { fixed } from "../stats";
import { abortable, mountFilling, pidsServing, sleep, waitFor } from "./p03Process";

// -- Type Imports --
import type { ProgramSource } from "../../../components/player/visualizers/gl/kit";
import type { MountedFrame } from "../frames";
import type { OutcomeState, ProbeModule, ProbeOutcome } from "../types";

// ---- Salt ----

const VERSION_LINE = /^(\s*#version[^\n]*\n)/;

/** Adds a unique comment line right after the `#version` line, which must stay the first line. */
export function saltSource(source: string, salt: string): string {
  if (!VERSION_LINE.test(source)) throw new Error("shader source does not start with a #version line");
  return source.replace(VERSION_LINE, `$1// run ${salt}\n`);
}

export function saltPrograms(programs: readonly ProgramSource[], salt: string): ProgramSource[] {
  return programs.map((p) => ({ name: p.name, vs: saltSource(p.vs, salt), fs: saltSource(p.fs, salt) }));
}

/** A random token for one run's salt. */
export function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Verdict ----

/** The pass lines: first frame under 300 ms with a process alive, under 1 s with none. */
export const WARM_LIMIT_MS = 300;
export const COLD_LIMIT_MS = 1000;

export interface P4Facts {
  coldMs: number;
  warmMs: number;
  /** False when a probe-vis process was already alive before the cold run. */
  coldWasCold: boolean;
  /** True when the process list showed a probe-vis process after the cold mount. */
  frameSeen: boolean;
  /** Programs that failed to link, over every run. */
  linkFailures: number;
}

export function p4Verdict(f: P4Facts): { state: OutcomeState; reasons: string[] } {
  if (f.linkFailures > 0) return { state: "invalid", reasons: [`${f.linkFailures} program(s) failed to link`] };
  if (!f.frameSeen) {
    return {
      state: "invalid",
      reasons: ["the process list does not show the frame: the cold reading is invalid, the warm readings are measurements only"],
    };
  }
  if (!f.coldWasCold) return { state: "invalid", reasons: ["a probe-vis process was alive before the cold run"] };
  if (!Number.isFinite(f.coldMs) || !Number.isFinite(f.warmMs)) {
    return { state: "invalid", reasons: ["a mount time is not a number"] };
  }
  const reasons: string[] = [];
  if (f.warmMs >= WARM_LIMIT_MS) reasons.push(`warm ${fixed(f.warmMs, 0)} ms is not under ${WARM_LIMIT_MS} ms`);
  if (f.coldMs >= COLD_LIMIT_MS) reasons.push(`cold ${fixed(f.coldMs, 0)} ms is not under ${COLD_LIMIT_MS} ms`);
  return reasons.length > 0 ? { state: "fail", reasons } : { state: "pass", reasons: [] };
}

// ---- Runs ----

const VIS_HOST = "probe-vis";
const SIZE = { w: 640, h: 360 };
const REMOUNT_GAP_MS = 300;
const MB = 1024 * 1024;

interface Run {
  ms: number;
  failed: string[];
}

function allPrograms(salt: string | null): ProgramSource[] {
  const all = [...LAKE_PROGRAMS, ...SHARED_PROGRAMS];
  return salt === null ? all.map((p) => ({ ...p })) : saltPrograms(all, salt);
}

/** Inserts a frame, posts it the programs and times insertion to its first-frame message. */
async function frameRun(
  parent: HTMLElement,
  programs: ProgramSource[],
  signal: AbortSignal,
  keep: MountedFrame[],
): Promise<Run> {
  const frame = await mountFilling(parent, VIS_HOST, "vis-mount.html", signal);
  keep.push(frame);
  const first = waitFor(frame.port, "first-frame", 20_000, signal);
  frame.port.postMessage({ type: "compile", programs, parallel: true });
  const msg = await first;
  const ms = performance.now() - frame.insertedAt;
  if (msg.refused) throw new Error("the frame could not create a WebGL2 context");
  return { ms, failed: Array.isArray(msg.failed) ? (msg.failed as string[]) : [] };
}

/** The same compile and one draw in a fresh context of the main document. */
async function mainRun(programs: ProgramSource[], signal: AbortSignal): Promise<Run> {
  const started = performance.now();
  const canvas = document.createElement("canvas");
  canvas.width = SIZE.w;
  canvas.height = SIZE.h;
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error("the page could not create a WebGL2 context");
  const ext = gl.getExtension("KHR_parallel_shader_compile");
  const built = programs.map((src) => {
    const program = gl.createProgram() as WebGLProgram;
    const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
    gl.shaderSource(vs, src.vs);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
    gl.shaderSource(fs, src.fs);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    return { program, name: src.name };
  });
  while (ext && built.some((b) => !gl.getProgramParameter(b.program, ext.COMPLETION_STATUS_KHR))) {
    await sleep(0, signal);
  }
  const failed = built.filter((b) => !gl.getProgramParameter(b.program, gl.LINK_STATUS)).map((b) => b.name);
  const ok = built.find((b) => gl.getProgramParameter(b.program, gl.LINK_STATUS));
  if (ok) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, SIZE.w, SIZE.h);
    gl.useProgram(ok.program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const ms = performance.now() - started;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { ms, failed };
}

/** Working set and private bytes of the probe-vis processes; a pid the host could not read is named. */
async function memoryLine(label: string, signal: AbortSignal): Promise<{ line: string; pids: number[] }> {
  const pids = pidsServing((await abortable(probeProcesses(), signal)).processes, VIS_HOST);
  if (pids.length === 0) return { line: `memory ${label}: no ${VIS_HOST} process listed`, pids };
  const read = await abortable(probeMemory(pids), signal).catch((e) => {
    if (signal.aborted) throw e;
    return [];
  });
  const line = `memory ${label}: ${pids
    .map((pid) => {
      const m = read.find((r) => r.pid === pid);
      return m ? `${pid} working set ${fixed(m.working_set / MB)} MB, private ${fixed(m.private_bytes / MB)} MB` : `${pid} unreadable`;
    })
    .join("; ")}`;
  return { line, pids };
}

async function run(ctx: Parameters<ProbeModule["run"]>[0]): Promise<ProbeOutcome> {
  const slot = ctx.stages.subject.slot;
  ctx.stages.subject.setBlend("normal");
  ctx.stages.subject.setDip(1);
  const frames: MountedFrame[] = [];
  const lines: string[] = [];
  let failures = 0;
  const note = (label: string, r: Run) => {
    failures += r.failed.length;
    lines.push(`${label}: ${fixed(r.ms, 0)} ms${r.failed.length ? `; failed: ${r.failed.join(" | ")}` : ""}`);
  };
  const drop = async () => {
    for (const f of frames.splice(0)) f.unmount();
  };
  try {
    const before = pidsServing((await abortable(probeProcesses(), ctx.signal)).processes, VIS_HOST);

    ctx.log("reference compile in the page");
    note("reference (page context, salted)", await mainRun(allPrograms(randomSalt()), ctx.signal));

    ctx.log("cold");
    const cold = await frameRun(slot, allPrograms(randomSalt()), ctx.signal, frames);
    note("cold (no probe-vis process alive before, lower bound)", cold);
    const afterCold = await memoryLine("after cold", ctx.signal);
    lines.push(afterCold.line);

    ctx.log("warm");
    const warm = await frameRun(slot, allPrograms(randomSalt()), ctx.signal, frames);
    note("warm (a second frame while one lives)", warm);
    lines.push((await memoryLine("with two frames", ctx.signal)).line);

    ctx.log("re-mount");
    await drop();
    await sleep(REMOUNT_GAP_MS, ctx.signal);
    note("re-mount (frame removed and inserted again within 1 s)", await frameRun(slot, allPrograms(randomSalt()), ctx.signal, frames));
    await drop();

    ctx.log("unsalted pair");
    const unsalted1 = await frameRun(slot, allPrograms(null), ctx.signal, frames);
    await drop();
    const unsalted2 = await frameRun(slot, allPrograms(null), ctx.signal, frames);
    note("unsalted first (cache effect)", unsalted1);
    note("unsalted second (cache effect)", unsalted2);

    const verdict = p4Verdict({
      coldMs: cold.ms,
      warmMs: warm.ms,
      coldWasCold: before.length === 0,
      frameSeen: afterCold.pids.length > 0,
      linkFailures: failures,
    });
    if (verdict.reasons.length > 0) lines.push(`reasons: ${verdict.reasons.join("; ")}`);
    return { state: verdict.state, lines };
  } finally {
    await drop();
  }
}

export const probe: ProbeModule = { id: "P4", run, timeoutMs: 90_000 };
