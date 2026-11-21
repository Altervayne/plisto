/*
 * The two ways a program becomes usable. The sync compile blocks until the program links and is what the
 * built-in kinds use. The deferred compile only submits, so the driver can compile several programs in
 * parallel, and a poll reports when the link has finished.
 */

/** Builds a program from two sources. A deferred compiler returns before the link has finished. */
export interface Compile {
  (gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram;
  deferred?: boolean;
}

/** Compiles and links at once, throwing the info log on failure. */
export const syncCompile: Compile = (gl, vsSrc, fsSrc) => {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("shader allocation failed");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error("program allocation failed");
  const vs = make(gl.VERTEX_SHADER, vsSrc);
  const fs = make(gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program link failed");
  return p;
};

const held = new WeakMap<WebGLProgram, { vs: WebGLShader; fs: WebGLShader }>();

/** Submits both shaders and the link without querying any status. Poll the handle with `pollProgram`. */
export const deferredCompile: Compile = Object.assign(
  (gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram => {
    const p = gl.createProgram();
    if (!p) throw new Error("program allocation failed");
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) throw new Error("shader allocation failed");
    gl.shaderSource(vs, vsSrc);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    // Kept until the program settles: a deleted shader no longer reports its own log.
    held.set(p, { vs, fs });
    return p;
  },
  { deferred: true },
);

/**
 * Whether a deferred program has finished. Without the parallel-compile extension a program counts as
 * finished on any poll. Once finished, a failed link throws the info log.
 */
export function pollProgram(gl: WebGL2RenderingContext, p: WebGLProgram): boolean {
  const ext = gl.getExtension("KHR_parallel_shader_compile");
  if (ext && !gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) return false;
  const shaders = held.get(p);
  held.delete(p);
  const linked = gl.getProgramParameter(p, gl.LINK_STATUS);
  let failure: string | null = null;
  if (!linked && shaders) {
    for (const [label, s] of [["vertex", shaders.vs], ["fragment", shaders.fs]] as const) {
      if (!failure && !gl.getShaderParameter(s, gl.COMPILE_STATUS)) failure = `${label}: ${gl.getShaderInfoLog(s) ?? "shader compile failed"}`;
    }
  }
  if (shaders) {
    gl.deleteShader(shaders.vs);
    gl.deleteShader(shaders.fs);
  }
  if (!linked) throw new Error(failure ?? gl.getProgramInfoLog(p) ?? "program link failed");
  return true;
}
