/*
 * Compiles a kind's programs on a hidden context ahead of the stage. The browser keeps one program cache
 * across contexts, so the stage's own compile of the same sources then costs almost nothing. Programs
 * are submitted without a status query, so they build off the main thread where the driver allows it,
 * and a frame loop polls for completion. A kind counts as warm once every program has finished or the
 * attempt failed: a failure never holds the stage, and the stage's own error path handles a real one.
 */

// -- Local Imports --
import { SHARED_PROGRAMS } from "./shaders";
import { markWarm } from "./warmState";
import { programsOf } from "../visualizerViews";

// -- State Imports --
import { isGlKind, type VisualizerKind } from "../../../../state/player/visualizerKind";

// -- Type Imports --
import type { ProgramSource } from "./kit";

// The extension's completion query, absent from the DOM typings.
const COMPLETION_STATUS_KHR = 0x91b1;

interface Entry {
  src: ProgramSource;
  program: WebGLProgram | null;
  done: boolean;
}

interface Job {
  kind: VisualizerKind;
  entries: Entry[];
}

interface WarmContext {
  gl: WebGL2RenderingContext;
  parallel: boolean;
}

let context: WarmContext | null | undefined;
const entries = new Map<string, Entry>();
const jobs = new Set<Job>();
let frame = 0;

function openContext(): WarmContext | null {
  if (context !== undefined) return context;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    context = gl ? { gl, parallel: gl.getExtension("KHR_parallel_shader_compile") != null } : null;
  } catch {
    context = null;
  }
  return context;
}

/** Submits a program with no status query; the compile and link run in the background. */
function submit(gl: WebGL2RenderingContext, src: ProgramSource): WebGLProgram | null {
  const p = gl.createProgram();
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!p || !vs || !fs) return null;
  gl.shaderSource(vs, src.vs);
  gl.shaderSource(fs, src.fs);
  gl.compileShader(vs);
  gl.compileShader(fs);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

// Drops the program once built; the cache keeps the binary.
function finish(gl: WebGL2RenderingContext, entry: Entry): void {
  if (entry.program) gl.deleteProgram(entry.program);
  entry.program = null;
  entry.done = true;
}

function settle(): void {
  for (const job of jobs) {
    if (!job.entries.every((e) => e.done)) continue;
    jobs.delete(job);
    markWarm(job.kind);
  }
}

// Gives up on the context: every waiting kind counts as warm so none strands.
function abandon(): void {
  context = null;
  entries.clear();
  for (const job of jobs) markWarm(job.kind);
  jobs.clear();
}

// Samples the completion query once per frame: the query is free, unlike the status check it replaces.
function poll(): void {
  frame = 0;
  const ctx = context;
  if (!ctx) return;
  const { gl } = ctx;
  if (gl.isContextLost()) {
    abandon();
    return;
  }
  for (const entry of entries.values()) {
    if (entry.done || !entry.program) continue;
    if (!gl.getProgramParameter(entry.program, COMPLETION_STATUS_KHR)) continue;
    finish(gl, entry);
  }
  settle();
  if (jobs.size > 0) frame = requestAnimationFrame(poll);
}

/** Runs `run` when the page is idle; the returned function cancels it. */
export function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run);
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 0);
  return () => window.clearTimeout(id);
}

// Without the extension a compile blocks, so each program takes its own idle slot, off the dip's path.
function compileInIdle(ctx: WarmContext, job: Job): void {
  const next = () => {
    const entry = job.entries.find((e) => !e.done);
    if (!entry) {
      settle();
      return;
    }
    whenIdle(() => {
      if (ctx.gl.isContextLost()) {
        abandon();
        return;
      }
      if (entry.done) {
        next();
        return;
      }
      try {
        const p = submit(ctx.gl, entry.src);
        // The status query forces the compile to finish here.
        if (p) ctx.gl.getProgramParameter(p, ctx.gl.LINK_STATUS);
        entry.program = p;
      } catch {
        // A failed compile still marks the kind warm; the stage reports its own error.
      }
      finish(ctx.gl, entry);
      next();
    });
  };
  next();
}

/**
 * Starts warming `kind`'s programs and the shared passes. Safe to call again: a kind already warm or in
 * progress is left alone.
 */
export function warmKind(kind: VisualizerKind): void {
  if (!isGlKind(kind)) return;
  for (const job of jobs) if (job.kind === kind) return;
  const ctx = openContext();
  if (!ctx) {
    markWarm(kind);
    return;
  }
  const job: Job = { kind, entries: [] };
  try {
    for (const src of [...SHARED_PROGRAMS, ...programsOf(kind)]) {
      let entry = entries.get(src.name);
      if (!entry) {
        entry = { src, program: null, done: false };
        entries.set(src.name, entry);
        if (ctx.parallel) {
          entry.program = submit(ctx.gl, src);
          if (!entry.program) finish(ctx.gl, entry);
        }
      }
      job.entries.push(entry);
    }
  } catch {
    // Warming is only an optimisation: on any failure the stage compiles the kind itself, as before.
    markWarm(kind);
    return;
  }
  jobs.add(job);
  if (ctx.parallel) {
    if (!frame) frame = requestAnimationFrame(poll);
  } else {
    compileInIdle(ctx, job);
  }
}
