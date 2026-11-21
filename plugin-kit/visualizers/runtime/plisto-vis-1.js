var plistoVis = (function(exports) {
  "use strict";var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  const BRIDGE_PROTOCOL = 1;
  const CALL_TIMEOUT_MS = 1e4;
  class BridgeError extends Error {
    constructor(code, message) {
      super(message || code);
      __publicField(this, "code");
      this.name = "BridgeError";
      this.code = code;
    }
  }
  function createBridgeClient(postToParent) {
    const pending = /* @__PURE__ */ new Map();
    let nextId = 1;
    const post = (msg) => postToParent({ ...msg, plisto: BRIDGE_PROTOCOL });
    const call2 = (method, args = {}) => new Promise((resolve, reject) => {
      let text;
      try {
        text = JSON.stringify(args ?? {});
      } catch {
        reject(new BridgeError("invalid_args", "The arguments could not be serialized."));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError("timeout", "The call timed out."));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      post({ type: "plisto:call", id, method, args: text });
    });
    const logAt = (level) => (text) => call2("log.write", { level, text: String(text) });
    const onResult = (data) => {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok === true) {
        entry.resolve(data.result);
        return;
      }
      const err = data.error ?? {};
      entry.reject(
        new BridgeError(
          typeof err.code === "string" ? err.code : "unavailable",
          typeof err.message === "string" ? err.message : void 0
        )
      );
    };
    return {
      call: call2,
      log: { debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") },
      storage: {
        get: (key, fallback) => call2("storage.get", { key }).then((r) => {
          const found = r;
          return found?.found ? found.value : fallback;
        }),
        set: (key, value) => call2("storage.set", { key, value }),
        remove: (key) => call2("storage.remove", { key }),
        keys: (prefix) => call2("storage.keys", prefix === void 0 ? {} : { prefix }),
        clear: () => call2("storage.clear", {}),
        usage: () => call2("storage.usage", {})
      },
      handle(data) {
        switch (data.type) {
          case "plisto:ping":
            post({ type: "plisto:pong", seq: data.seq });
            return true;
          case "plisto:result":
            onResult(data);
            return true;
          default:
            return false;
        }
      }
    };
  }
  function candidateForm(factory, options = {}) {
    const programs = options.programs ?? [];
    return () => ({ form: "gl", programs, factory });
  }
  function rawForm(handlers) {
    if (typeof handlers?.frame !== "function") throw new Error("a raw visualizer needs a frame handler");
    return () => ({ form: "raw", handlers });
  }
  function createCoverTexture(gl) {
    const tex = gl.createTexture();
    if (!tex) throw new Error("texture allocation failed");
    let uploaded = null;
    const sync = (bitmap) => {
      if (bitmap === uploaded) return false;
      uploaded = bitmap;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      return true;
    };
    return { tex, sync, dispose: () => gl.deleteTexture(tex) };
  }
  const HUSH_SLOTS = 2;
  const HUSH = `
uniform vec4 uHush[${HUSH_SLOTS}];
uniform float uHushFeather;
float hushAt(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < ${HUSH_SLOTS}; i++) {
    vec4 r = uHush[i];
    if (r.z <= 0.0) continue;
    vec2 rad = r.zw * 0.7071;
    vec2 q = p - (r.xy + r.zw * 0.5);
    float k1 = length(q / rad);
    float sd = k1 < 1.0 ? (k1 - 1.0) * min(rad.x, rad.y) : k1 * (k1 - 1.0) / length(q / (rad * rad));
    h = max(h, 1.0 - smoothstep(-0.25 * uHushFeather, uHushFeather, sd));
  }
  return h;
}
`;
  const FS_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uTime;
uniform float uBands[24];
uniform float uRms;
uniform float uPeak;
uniform float uFlux;
uniform float uKick;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform vec3 uPal[3];
uniform vec4 uCover;
uniform float uRadius;
uniform float uAmbient;
uniform float uDpr;
in vec2 vUv;
out vec4 outColor;
const float PI = 3.14159265;
const float TAU = 6.2831853;
float band(float m) {
  float f = clamp(m, 0.0, 1.0) * 23.0;
  int i = int(floor(f));
  int j = min(i + 1, 23);
  float k = f - float(i);
  k = k * k * (3.0 - 2.0 * k);
  return mix(uBands[i], uBands[j], k);
}
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 pal(float x) { x = clamp(x, 0.0, 2.0); return x < 1.0 ? mix(uPal[0], uPal[1], x) : mix(uPal[1], uPal[2], x - 1.0); }
vec2 coverCenter() { return uCover.xy + uCover.zw * 0.5; }
`;
  const TRAIL_FS = `${PRELUDE}
uniform sampler2D uPrev;
uniform float uDecay;
uniform vec2 uCenter;
uniform float uZoom;
uniform float uRot;
void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float c = cos(uRot), s = sin(uRot);
  p = mat2(c, -s, s, c) * p / uZoom;
  vec2 uv = (p + uCenter) / uRes;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  outColor = texture(uPrev, uv) * uDecay * inside;
}`;
  const DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 s = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s *= 0.25;
  float l = max(s.r, max(s.g, s.b));
  outColor = vec4(s * (max(0.0, l - uThreshold) / max(l, 1e-4)), 1.0);
}`;
  const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.227027;
  c += (texture(uSrc, vUv + uDir * 1.3846).rgb + texture(uSrc, vUv - uDir * 1.3846).rgb) * 0.3162162;
  c += (texture(uSrc, vUv + uDir * 3.2308).rgb + texture(uSrc, vUv - uDir * 3.2308).rgb) * 0.0702703;
  outColor = vec4(c, 1.0);
}`;
  const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform int uMode;
uniform float uBloomK;
uniform float uExposure;
uniform vec4 uMask;
uniform float uMaskOn;
uniform float uFeather;
uniform float uVignette;
uniform vec2 uRes;
in vec2 vUv;
out vec4 outColor;
float maskAt(vec2 fc) {
  float m = 1.0;
  if (uMaskOn > 0.5) {
    vec2 d = max(uMask.xy - fc, fc - (uMask.xy + uMask.zw));
    m = 1.0 - smoothstep(-uFeather, 0.0, max(d.x, d.y));
  }
  vec2 q = (vUv - 0.5) * vec2(1.0, 1.1);
  return m * mix(1.0, smoothstep(0.85, 0.25, length(q)), uVignette);
}
void main() {
  vec4 s = texture(uScene, vUv);
  vec3 b = texture(uB1, vUv).rgb * 0.7 + texture(uB2, vUv).rgb * 1.0;
  vec3 c = max(s.rgb + b * uBloomK, 0.0);
  float m = maskAt(gl_FragCoord.xy);
  if (uMode == 0) {
    outColor = vec4((1.0 - exp(-c * uExposure)) * m, 1.0);
  } else if (uMode == 1) {
    float mx = max(c.r, max(c.g, c.b));
    float i = 1.0 - exp(-mx * uExposure);
    vec3 hue = c / max(mx, 1e-4);
    vec3 ink = pow(hue, vec3(1.8)) * (0.78 - 0.28 * i);
    // Push the ink's chroma so palette hues stay colored on paper instead of drifting to grey.
    ink = clamp(mix(vec3(dot(ink, vec3(0.299, 0.587, 0.114))), ink, 1.45), 0.0, 1.0);
    outColor = vec4(mix(vec3(1.0), ink, i * 0.92 * m), 1.0);
  } else {
    vec3 col = s.rgb + b * uBloomK * s.a;
    outColor = vec4(min(col, vec3(s.a)) * m, s.a * m);
  }
}`;
  const TRAIL_PROGRAM = { name: "trail", vs: FS_VS, fs: TRAIL_FS };
  const DOWN_PROGRAM = { name: "down", vs: FS_VS, fs: DOWN_FS };
  const BLUR_PROGRAM = { name: "blur", vs: FS_VS, fs: BLUR_FS };
  const COMPOSITE_PROGRAM = { name: "composite", vs: FS_VS, fs: COMPOSITE_FS };
  const SHARED_PROGRAMS = [COMPOSITE_PROGRAM, DOWN_PROGRAM, BLUR_PROGRAM, TRAIL_PROGRAM];
  const RING_SLOTS = 3;
  const FLUID_PRELUDE = `${PRELUDE}
${HUSH}
uniform float uSwell;
uniform float uBassM;
uniform float uMidM;
uniform float uHighM;
uniform float uFlow;
uniform float uLight;
uniform float uFloor;
uniform vec3 uGround;
uniform sampler2D uCoverTex;
// Per beat ring: its age in seconds and its faded height.
uniform vec2 uRings[${RING_SLOTS}];
// Three octaves, 0..1, each turned so the lattice never shows.
float fbm(vec2 p) {
  float s = vnoise(p) * 0.57;
  p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.7;
  s += vnoise(p) * 0.29;
  p = mat2(1.6, 1.2, -1.2, 1.6) * p + 1.3;
  return s + vnoise(p) * 0.14;
}
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// A stage point in cover widths from the cover's centre.
vec2 coverQ(vec2 fc) { return (fc - coverCenter()) / uCover.z; }
// The cover stretched across the stage, the way Liquid lays its backdrop.
vec2 stageUv(vec2 fc) { vec2 su = fc / uRes; return (su - 0.5) * vec2(uRes.x / uRes.y, 1.0) / 1.35 + 0.5; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// The beat rings at distance d in cover widths: a smooth bump per ring, travelling at speed.
float rings(float d, float speed, float width) {
  float h = 0.0;
  for (int i = 0; i < ${RING_SLOTS}; i++) {
    float x = (d - uRings[i].x * speed) / width;
    h += uRings[i].y * exp(-x * x);
  }
  return h;
}
// Ambient only: the stage settles toward the ground at its corners and under the transport.
vec3 settle(vec3 col, vec2 fc) {
  if (uAmbient < 0.5) return col;
  vec2 su = fc / uRes;
  float v = smoothstep(1.12, 0.3, length((su - 0.5) * vec2(1.05, 1.0)));
  float low = smoothstep(uFloor - 40.0 * uDpr, uFloor + 160.0 * uDpr, fc.y);
  return mix(uGround, col, (0.5 + 0.5 * v) * (0.55 + 0.45 * low));
}
`;
  function createRings(life, rise, height) {
    const live = [];
    const packed = new Float32Array(RING_SLOTS * 2);
    return {
      packed,
      step(dt, beat) {
        for (const ring of live) ring.age += dt;
        while (live.length > 0 && live[0].age >= life) live.shift();
        if (beat > 0) {
          if (live.length === RING_SLOTS) live.shift();
          live.push({ age: 0, strength: Math.min(1.5, beat) });
        }
        packed.fill(0);
        live.forEach((ring, i) => {
          const fadeIn = Math.min(1, ring.age / rise);
          const fadeOut = (1 - ring.age / life) ** 2;
          packed[i * 2] = ring.age;
          packed[i * 2 + 1] = ring.strength * height * fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut;
        });
      },
      clear() {
        live.length = 0;
        packed.fill(0);
      }
    };
  }
  const NO_RINGS = new Float32Array(RING_SLOTS * 2);
  function setFluid(kit, p, f, flow, rings, coverTex) {
    const { gl } = kit;
    const s = f.sig;
    kit.setCommon(p, f);
    kit.set1(p, "uSwell", Math.min(1, s.swell * 1.6));
    kit.set1(p, "uBassM", s.bassMotion);
    kit.set1(p, "uMidM", s.midMotion);
    kit.set1(p, "uHighM", s.highMotion);
    kit.set1(p, "uFlow", flow);
    kit.set1(p, "uLight", f.light ? 1 : 0);
    kit.set1(p, "uFloor", kit.geo.floor ?? 0);
    gl.uniform3f(kit.uniform(p, "uGround"), f.ground[0], f.ground[1], f.ground[2]);
    gl.uniform2fv(kit.uniform(p, "uRings"), rings ?? NO_RINGS);
    if (coverTex) kit.bindTex(p, "uCoverTex", 0, coverTex);
  }
  const SCENE_PRELUDE = `${FLUID_PRELUDE}
uniform float uLevel;
const float uBackdrop = 0.0;
`;
  function setScene(kit, p, f, flow, rings, coverTex) {
    setFluid(kit, p, f, flow, rings, coverTex);
    kit.set1(p, "uLevel", f.sig.level);
  }
  const COPY_PROGRAM = {
    name: "scene:copy",
    vs: FS_VS,
    fs: `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texture(uSrc, vUv); }`
  };
  const programOf = (pass) => ({ name: `scene:${pass.name}`, vs: FS_VS, fs: pass.fs });
  function checkPasses(passes) {
    if (!Array.isArray(passes) || passes.length === 0) throw new Error("a scene needs at least one pass");
    const seen = /* @__PURE__ */ new Set();
    for (const pass of passes) {
      if (typeof pass.name !== "string" || typeof pass.fs !== "string") throw new Error("a pass needs a name and fs");
      if (seen.has(pass.name)) throw new Error(`pass ${pass.name} is declared twice`);
      for (const input of pass.inputs ?? []) {
        if (!seen.has(input)) throw new Error(`pass ${pass.name} samples ${input}, which does not draw before it`);
      }
      seen.add(pass.name);
    }
  }
  function sceneForm(spec) {
    checkPasses(spec.passes);
    const passes = spec.passes;
    const programs = passes.map(programOf);
    const last = passes[passes.length - 1];
    if (last.feedback) programs.push(COPY_PROGRAM);
    return () => ({ form: "gl", programs, factory: (kit) => sceneCandidate(kit, spec, programs) });
  }
  function sceneCandidate(kit, spec, programs) {
    const { gl } = kit;
    const passes = spec.passes;
    const lastIndex = passes.length - 1;
    const state = spec.init ? spec.init(kit) : void 0;
    const cover = createCoverTexture(gl);
    const rings = spec.rings ? createRings(spec.rings.life, spec.rings.rise, spec.rings.height) : null;
    const buffers = /* @__PURE__ */ new Map();
    const outputs = /* @__PURE__ */ new Map();
    let sizedFor = "";
    const freeBuffers = () => {
      for (const b of buffers.values()) b.targets.forEach(kit.freeTarget);
      buffers.clear();
    };
    const fitBuffers = () => {
      const key = `${kit.size.w}x${kit.size.h}`;
      if (key === sizedFor) return;
      sizedFor = key;
      freeBuffers();
      passes.forEach((pass, i) => {
        if (i === lastIndex && !pass.feedback) return;
        const scale = Math.min(1, Math.max(0.05, pass.scale ?? 1));
        const w = Math.max(1, Math.round(kit.size.w * scale));
        const h = Math.max(1, Math.round(kit.size.h * scale));
        const count = pass.feedback ? 2 : 1;
        buffers.set(pass.name, { targets: Array.from({ length: count }, () => kit.makeTarget(w, h)), current: 0 });
      });
    };
    const setBlend = (pass) => {
      if (pass.blend === "add") {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else {
        gl.disable(gl.BLEND);
      }
    };
    const draw = (frame) => {
      const scene2 = kit.boundTarget();
      fitBuffers();
      const flow = spec.update?.(frame, state);
      rings?.step(frame.dt, frame.sig.beat);
      const coverTex = frame.cover ? (cover.sync(frame.cover), cover.tex) : null;
      passes.forEach((pass, i) => {
        const p = kit.program(programs[i]);
        const own = buffers.get(pass.name);
        const dst = own ? own.targets[own.current] : scene2;
        kit.bindTarget(dst);
        setBlend(pass);
        setScene(kit, p, frame, typeof flow === "number" ? flow : 0, rings?.packed ?? null, coverTex);
        kit.set2(p, "uPassRes", dst ? dst.w : kit.size.w, dst ? dst.h : kit.size.h);
        let unit = 1;
        for (const input of pass.inputs ?? []) {
          const tex = outputs.get(input);
          if (tex) kit.bindTex(p, input, unit++, tex);
        }
        if (own && own.targets.length === 2) kit.bindTex(p, "uPrev", unit, own.targets[1 - own.current].tex);
        spec.uniforms?.(pass.name, p, kit, frame, state);
        kit.drawQuad();
        if (own) {
          outputs.set(pass.name, own.targets[own.current].tex);
          own.current = (own.current + 1) % own.targets.length;
        }
      });
      const lastOwn = outputs.get(passes[lastIndex].name);
      if (passes[lastIndex].feedback && lastOwn) {
        const copy = kit.program(COPY_PROGRAM);
        kit.bindTarget(scene2);
        setBlend(passes[lastIndex]);
        gl.useProgram(copy.handle);
        kit.bindTex(copy, "uSrc", 0, lastOwn);
        kit.drawQuad();
      }
      gl.disable(gl.BLEND);
    };
    return {
      mode: spec.mode ?? "glow",
      bloom: spec.bloom ?? 0,
      exposure: spec.exposure ?? 1,
      inkGain: spec.inkGain ?? 1,
      trail: spec.trail ?? null,
      vignette: spec.vignette,
      draw: (f) => draw(f),
      dispose() {
        freeBuffers();
        cover.dispose();
        spec.dispose?.(state, kit);
      }
    };
  }
  const COZY_PRELUDE = `${FLUID_PRELUDE}
// Soft disc, 1 inside, 0 outside, feather as a share of the radius.
float disc(vec2 d, float r, float feather) { return 1.0 - smoothstep(r * (1.0 - feather), r, length(d)); }
// Vignette weight, 1 at the centre to 0 at the corners.
float vig(vec2 fc) { vec2 su = fc / uRes; return smoothstep(1.15, 0.25, length((su - 0.5) * vec2(1.1, 1.0))); }
`;
  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }
  function createRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const BAND_COUNT = 24;
  const FINE_BAND_COUNT = 128;
  function settingUniform(id) {
    return `uSetting_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
  }
  function shaderPrelude(shapes) {
    const settings = shapes.map((s) => `uniform ${s.type === "color" ? "vec3" : "float"} ${settingUniform(s.id)};`).join("\n");
    return `${COZY_PRELUDE}
uniform float uLevel;
uniform sampler2D uPrev;
uniform float uFine[${FINE_BAND_COUNT}];
${settings}
#line 1
`;
  }
  const hexColor = (value) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
  };
  function setSettings(kit, p, frame, shapes) {
    for (const shape of shapes) {
      const value = frame.settings[shape.id];
      const name = settingUniform(shape.id);
      if (shape.type === "color") {
        const rgb = value === "cover" ? [frame.palette[0], frame.palette[1], frame.palette[2]] : hexColor(String(value));
        const loc = kit.uniform(p, name);
        if (loc && rgb) kit.gl.uniform3f(loc, rgb[0], rgb[1], rgb[2]);
      } else if (shape.type === "choice") {
        kit.set1(p, name, Math.max(0, (shape.options ?? []).indexOf(String(value))));
      } else if (shape.type === "toggle") {
        kit.set1(p, name, value === true ? 1 : 0);
      } else {
        kit.set1(p, name, typeof value === "number" ? value : 0);
      }
    }
  }
  function shaderForm(spec) {
    if (typeof spec?.source !== "string") throw new Error("a shader visualizer needs its source");
    return (init) => {
      const shapes = init.settingShapes;
      const fine = new Float32Array(FINE_BAND_COUNT);
      return sceneForm({
        passes: [{ name: "main", fs: shaderPrelude(shapes) + spec.source, feedback: true }],
        mode: spec.mode,
        bloom: spec.bloom,
        exposure: spec.exposure,
        inkGain: spec.inkGain,
        vignette: spec.vignette,
        uniforms(_pass, p, kit, frame) {
          fine.fill(0);
          if (frame.fine) fine.set(frame.fine.slice(0, FINE_BAND_COUNT));
          const loc = kit.uniform(p, "uFine");
          if (loc) kit.gl.uniform1fv(loc, fine);
          setSettings(kit, p, frame, shapes);
        }
      })(init);
    };
  }
  const syncCompile = (gl, vsSrc, fsSrc) => {
    const make = (type, src) => {
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
  const held = /* @__PURE__ */ new WeakMap();
  const deferredCompile = Object.assign(
    (gl, vsSrc, fsSrc) => {
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
      held.set(p, { vs, fs });
      return p;
    },
    { deferred: true }
  );
  function pollProgram(gl, p) {
    const ext = gl.getExtension("KHR_parallel_shader_compile");
    if (ext && !gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) return false;
    const shaders = held.get(p);
    held.delete(p);
    const linked = gl.getProgramParameter(p, gl.LINK_STATUS);
    let failure = null;
    if (!linked && shaders) {
      for (const [label, s] of [["vertex", shaders.vs], ["fragment", shaders.fs]]) {
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
  class ProgramPending extends Error {
    constructor(program) {
      super(`program ${program} is still compiling`);
      __publicField(this, "program");
      this.program = program;
    }
  }
  const HUSH_FEATHER = 110;
  function createKit(gl, compile = syncCompile) {
    const floatOk = gl.getExtension("EXT_color_buffer_float") != null;
    const programs = /* @__PURE__ */ new Map();
    const size = { w: 1, h: 1, dpr: 1 };
    const geo = { cover: [0, 0, 1, 1], radius: 16, mask: null, floor: null, hush: [] };
    const hush = new Float32Array(HUSH_SLOTS * 4);
    const quad = gl.createVertexArray();
    const quadVbo = gl.createBuffer();
    gl.bindVertexArray(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const compiling = /* @__PURE__ */ new Map();
    const program = ({ name, vs, fs }) => {
      let p = programs.get(name);
      if (!p) {
        p = { handle: compile(gl, vs, fs), loc: /* @__PURE__ */ new Map() };
        programs.set(name, p);
        if (compile.deferred) {
          compiling.set(name, p);
          throw new ProgramPending(name);
        }
      } else if (compiling.has(name)) {
        if (!settle(name)) throw new ProgramPending(name);
      }
      return p;
    };
    const settle = (name) => {
      const p = compiling.get(name);
      if (!p) return true;
      let done;
      try {
        done = pollProgram(gl, p.handle);
      } catch (e) {
        gl.deleteProgram(p.handle);
        programs.delete(name);
        compiling.delete(name);
        throw e;
      }
      if (done) compiling.delete(name);
      return done;
    };
    const pending = () => [...compiling.keys()].filter((n) => !settle(n));
    const uniform = (p, name) => {
      if (!p.loc.has(name)) p.loc.set(name, gl.getUniformLocation(p.handle, name));
      return p.loc.get(name) ?? null;
    };
    const set1 = (p, name, v) => {
      const l = uniform(p, name);
      if (l) gl.uniform1f(l, v);
    };
    const set2 = (p, name, a, b) => {
      const l = uniform(p, name);
      if (l) gl.uniform2f(l, a, b);
    };
    const set4 = (p, name, v) => {
      const l = uniform(p, name);
      if (l) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    };
    const seti = (p, name, v) => {
      const l = uniform(p, name);
      if (l) gl.uniform1i(l, v);
    };
    const bindTex = (p, name, unit, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      seti(p, name, unit);
    };
    const setCommon = (p, f) => {
      gl.useProgram(p.handle);
      const s = f.sig;
      set2(p, "uRes", size.w, size.h);
      set1(p, "uTime", f.t);
      set1(p, "uDpr", size.dpr);
      const lb = uniform(p, "uBands");
      if (lb) gl.uniform1fv(lb, s.bands);
      set1(p, "uRms", s.level);
      set1(p, "uPeak", s.peak);
      set1(p, "uFlux", s.flux);
      set1(p, "uKick", s.kick);
      set1(p, "uBass", s.bass);
      set1(p, "uMid", s.mid);
      set1(p, "uHigh", s.high);
      const lp = uniform(p, "uPal");
      if (lp) gl.uniform3fv(lp, f.palette);
      set4(p, "uCover", geo.cover);
      set1(p, "uRadius", geo.radius);
      set1(p, "uAmbient", f.ambient ? 1 : 0);
      const lh = uniform(p, "uHush");
      if (lh) {
        hush.fill(0);
        geo.hush.slice(0, HUSH_SLOTS).forEach((r, i) => hush.set(r, i * 4));
        gl.uniform4fv(lh, hush);
        set1(p, "uHushFeather", HUSH_FEATHER * size.dpr);
      }
    };
    const drawQuad = () => {
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const makeTarget = (w, h) => {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!tex || !fbo) throw new Error("target allocation failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (floatOk) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo, w, h };
    };
    const freeTarget = (t) => {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    };
    let bound = null;
    const bindTarget = (t) => {
      bound = t;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, t ? t.w : size.w, t ? t.h : size.h);
    };
    const dispose = () => {
      for (const p of programs.values()) gl.deleteProgram(p.handle);
      programs.clear();
      compiling.clear();
      gl.deleteVertexArray(quad);
      gl.deleteBuffer(quadVbo);
    };
    return {
      gl,
      size,
      geo,
      program,
      pending,
      uniform,
      set1,
      set2,
      set4,
      seti,
      bindTex,
      setCommon,
      drawQuad,
      makeTarget,
      freeTarget,
      bindTarget,
      boundTarget: () => bound,
      dispose
    };
  }
  class MountError extends Error {
    constructor(stage, message) {
      super(message);
      __publicField(this, "stage");
      this.stage = stage;
    }
  }
  const errorText = (e) => e instanceof Error ? e.message : String(e);
  const STAGE_PROGRAMS = new Set(SHARED_PROGRAMS.map((p) => p.name));
  function createGate(programs, factory) {
    let kit = null;
    let heldThisFrame = false;
    let last = null;
    const waiting2 = (k) => {
      try {
        return k.pending();
      } catch (e) {
        throw new MountError("compile", errorText(e));
      }
    };
    const submit = (k) => {
      const taken = programs.find((p) => STAGE_PROGRAMS.has(p.name));
      if (taken) throw new MountError("setup", `program name ${taken.name} belongs to the stage`);
      for (const p of [...SHARED_PROGRAMS, ...programs]) {
        try {
          k.program(p);
        } catch (e) {
          if (!(e instanceof ProgramPending)) throw new MountError("compile", errorText(e));
        }
      }
    };
    return {
      factory(k) {
        if (!kit) {
          kit = k;
          heldThisFrame = true;
          submit(k);
        }
        if (heldThisFrame) throw new ProgramPending(programs[0]?.name ?? SHARED_PROGRAMS[0].name);
        const left = waiting2(k);
        if (left.length > 0) throw new ProgramPending(left[0]);
        last?.dispose();
        last = null;
        let made;
        try {
          made = factory(k);
        } catch (e) {
          if (e instanceof ProgramPending) throw e;
          throw new MountError("setup", errorText(e));
        }
        const own = made.dispose;
        let disposed = false;
        made.dispose = () => {
          if (disposed) return;
          disposed = true;
          own.call(made);
        };
        last = made;
        return made;
      },
      nextFrame() {
        heldThisFrame = false;
      },
      hold() {
        heldThisFrame = true;
      },
      blocked: () => kit !== null && (heldThisFrame || waiting2(kit).length > 0)
    };
  }
  function smoothBands(prev, target, attack, decay) {
    const base = prev.length === target.length ? prev : new Array(target.length).fill(0);
    return target.map((t, i) => {
      const p = base[i];
      const rate = t > p ? attack : decay;
      return p + (t - p) * rate;
    });
  }
  const LEVEL_TAU = 0.9;
  const SWELL_TAU = 1.1;
  const MOTION_ATTACK_SECS = 0.05;
  const BEAT_MIN_GAP_SECS = 0.3;
  const BEAT_MAX_PER_SEC = 3;
  const REACTIVITY_PROFILES = {
    calm: { gain: 0, release: 0.4 },
    balanced: { gain: 1, release: 0.4 },
    lively: { gain: 1.6, release: 0.3 }
  };
  function restingBands() {
    return Float32Array.from({ length: BAND_COUNT }, (_, i) => 0.06 + 0.1 * Math.sin(Math.PI * i / (BAND_COUNT - 1)));
  }
  function restSignal() {
    return {
      bands: restingBands(),
      rms: 0.3,
      peak: 0.35,
      flux: 0,
      kick: 0,
      bass: 0.1,
      mid: 0.15,
      high: 0.1,
      level: 0.3,
      swell: 0.1,
      bassMotion: 0,
      midMotion: 0,
      highMotion: 0,
      beat: 0,
      drive: 0,
      loudness: 0.3,
      bassHit: 0,
      midHit: 0,
      highHit: 0,
      beatWeight: 0,
      surge: 0,
      cut: 0
    };
  }
  function easeEnvelope(prev, target, dt, tau) {
    return prev + (target - prev) * (1 - Math.exp(-dt / tau));
  }
  function motionEnvelope(prev, target, dt, release) {
    return easeEnvelope(prev, target, dt, target > prev ? MOTION_ATTACK_SECS : release);
  }
  function admitBeat(fired, now) {
    if (fired.length > 0 && now - fired[fired.length - 1] < BEAT_MIN_GAP_SECS) return false;
    let inWindow = 0;
    for (const t of fired) if (now - t < 1) inWindow++;
    return inWindow < BEAT_MAX_PER_SEC;
  }
  const FINE_ATTACK = 0.5;
  const FINE_DECAY = 0.15;
  const STILL_T = 14;
  function createFrameBuilder() {
    let fine = null;
    let latest = null;
    const shared = (ctx) => ({
      palette: ctx.palette,
      light: ctx.light,
      ambient: ctx.ambient,
      cover: ctx.cover,
      mirrored: false,
      backing: ctx.colors.backing,
      ground: ctx.colors.ground,
      settings: ctx.settings,
      colors: ctx.colors
    });
    return {
      build(tick, dt, ctx) {
        latest = tick;
        fine = tick.fine ? smoothBands(fine ?? [], tick.fine, FINE_ATTACK, FINE_DECAY) : null;
        return {
          ...shared(ctx),
          t: tick.t,
          dt,
          sig: tick.sig,
          still: false,
          playing: tick.playing,
          fine,
          progress: tick.progress,
          rawBands: tick.rawBands,
          nBeats: tick.nBeats,
          beatAt: tick.beatAt,
          trackSeq: tick.trackSeq,
          pointer: tick.pointer,
          wave: tick.wave
        };
      },
      rest(ctx) {
        return {
          ...shared(ctx),
          t: STILL_T,
          dt: 1 / 60,
          sig: restSignal(),
          still: true,
          playing: latest?.playing ?? false,
          fine: null,
          progress: latest?.progress ?? null,
          rawBands: [],
          nBeats: 0,
          beatAt: latest?.beatAt ?? null,
          trackSeq: latest?.trackSeq ?? 0,
          pointer: null,
          wave: null
        };
      }
    };
  }
  const VIS_API = 1;
  const VIS_INIT_TYPE = "plisto:vis-init";
  const SIGNAL_FOLD = {
    bands: "latest",
    rms: "latest",
    peak: "latest",
    flux: "max",
    kick: "max",
    bass: "latest",
    mid: "latest",
    high: "latest",
    level: "latest",
    swell: "latest",
    bassMotion: "latest",
    midMotion: "latest",
    highMotion: "latest",
    beat: "max",
    drive: "latest",
    loudness: "latest",
    bassHit: "max",
    midHit: "max",
    highHit: "max",
    beatWeight: "max",
    surge: "max",
    cut: "max"
  };
  const MAX_CARRY = Object.keys(SIGNAL_FOLD).filter(
    (key) => SIGNAL_FOLD[key] === "max"
  );
  function foldTick(held2, next) {
    const sig = { ...next.sig };
    for (const key of MAX_CARRY) {
      sig[key] = Math.max(held2.sig[key], next.sig[key]);
    }
    return { ...next, sig, dt: held2.dt + next.dt, nBeats: held2.nBeats + next.nBeats };
  }
  const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  function readInit(data) {
    if (!isObject(data) || data.plisto !== 1 || data.type !== VIS_INIT_TYPE) return null;
    if (!isCount(data.api) || typeof data.kind !== "string" || !isObject(data.context)) return null;
    if (!isObject(data.composite) || !isObject(data.needs) || !Array.isArray(data.settingShapes)) return null;
    return data;
  }
  function readHostMessage(data) {
    if (!isObject(data)) return null;
    switch (data.type) {
      case "tick":
        return isCount(data.seq) && isNum(data.t) && isNum(data.dt) && data.dt >= 0 && isObject(data.sig) && isCount(data.nBeats) ? data : null;
      case "update":
        return isObject(data.context) ? data : null;
      case "still":
        return isCount(data.id) ? data : null;
      case "dispose":
        return { type: "dispose" };
      default:
        return null;
    }
  }
  const RAF_STARVED_MS = 100;
  const IDLE_STOP_MS = 250;
  const DT_MAX = 0.05;
  function createFrameTransport(deps) {
    let waiting2 = null;
    let lastTickAt = -Infinity;
    let lastFrameAt = -Infinity;
    let frameId = null;
    let lastMs = null;
    let disposed = false;
    const consume = () => {
      const tick = waiting2;
      if (!tick) return;
      waiting2 = null;
      deps.postAck(tick.seq, lastMs);
      const start2 = deps.now();
      try {
        deps.step(tick, Math.min(DT_MAX, tick.dt));
      } finally {
        lastMs = deps.now() - start2;
      }
    };
    const onFrame = () => {
      frameId = null;
      if (disposed) return;
      lastFrameAt = deps.now();
      consume();
      if (deps.now() - lastTickAt < IDLE_STOP_MS) frameId = deps.requestFrame(onFrame);
    };
    return {
      onTick(tick) {
        if (disposed) return;
        const now = deps.now();
        lastTickAt = now;
        const queued = waiting2 !== null;
        waiting2 = waiting2 ? foldTick(waiting2, tick) : tick;
        if (frameId === null) {
          lastFrameAt = now;
          frameId = deps.requestFrame(onFrame);
        }
        if (queued || now - lastFrameAt > RAF_STARVED_MS) consume();
      },
      dispose() {
        disposed = true;
        waiting2 = null;
        if (frameId !== null) deps.cancelFrame(frameId);
        frameId = null;
      }
    };
  }
  const MODE_INDEX = { light: 0, ink: 1, image: 2 };
  const MAX_DPR = 2;
  const AMBIENT_VIGNETTE = 0.35;
  function createRenderer(canvas, resolve, compile = syncCompile) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    const kit = createKit(gl, compile);
    let targets = null;
    let current2 = null;
    let flip = 0;
    const freeTargets = () => {
      if (!targets) return;
      for (const target of Object.values(targets)) kit.freeTarget(target);
      targets = null;
    };
    const resizeTargets = () => {
      freeTargets();
      const { w, h } = kit.size;
      const qw = Math.max(1, w >> 2);
      const qh = Math.max(1, h >> 2);
      const ew = Math.max(1, w >> 3);
      const eh = Math.max(1, h >> 3);
      targets = {
        scene0: kit.makeTarget(w, h),
        scene1: kit.makeTarget(w, h),
        q0: kit.makeTarget(qw, qh),
        q1: kit.makeTarget(qw, qh),
        e0: kit.makeTarget(ew, eh),
        e1: kit.makeTarget(ew, eh)
      };
    };
    const fit = (layout) => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.max(1, Math.round(layout.width * dpr));
      const h = Math.max(1, Math.round(layout.height * dpr));
      kit.size.dpr = dpr;
      if (w !== kit.size.w || h !== kit.size.h || !targets) {
        kit.size.w = w;
        kit.size.h = h;
        canvas.width = w;
        canvas.height = h;
        resizeTargets();
      }
      const toGl = (r) => [r[0] * dpr, h - (r[1] + r[3]) * dpr, r[2] * dpr, r[3] * dpr];
      kit.geo.cover = toGl(layout.cover);
      kit.geo.radius = layout.radius * dpr;
      kit.geo.mask = layout.mask ? toGl(layout.mask) : null;
      kit.geo.floor = layout.floor != null ? h - layout.floor * dpr : null;
      kit.geo.hush = layout.hush.map(toGl);
    };
    const bloomChain = (T, src, threshold) => {
      const { gl: g } = kit;
      const down = kit.program(DOWN_PROGRAM);
      const blur = kit.program(BLUR_PROGRAM);
      g.disable(g.BLEND);
      g.useProgram(down.handle);
      kit.bindTarget(T.q0);
      kit.bindTex(down, "uSrc", 0, src.tex);
      kit.set2(down, "uTexel", 1 / src.w, 1 / src.h);
      kit.set1(down, "uThreshold", threshold);
      kit.drawQuad();
      const pass = (from, to, dx, dy) => {
        kit.bindTarget(to);
        g.useProgram(blur.handle);
        kit.bindTex(blur, "uSrc", 0, from.tex);
        kit.set2(blur, "uDir", dx / from.w, dy / from.h);
        kit.drawQuad();
      };
      pass(T.q0, T.q1, 1.5, 0);
      pass(T.q1, T.q0, 0, 1.5);
      g.useProgram(down.handle);
      kit.bindTarget(T.e0);
      kit.bindTex(down, "uSrc", 0, T.q0.tex);
      kit.set2(down, "uTexel", 1 / T.q0.w, 1 / T.q0.h);
      kit.set1(down, "uThreshold", 0);
      kit.drawQuad();
      pass(T.e0, T.e1, 2, 0);
      pass(T.e1, T.e0, 0, 2);
    };
    const composite = (T, src, traits, mode, bloom, c, f) => {
      const { gl: g } = kit;
      const p = kit.program(COMPOSITE_PROGRAM);
      kit.bindTarget(null);
      g.disable(g.BLEND);
      g.useProgram(p.handle);
      kit.bindTex(p, "uScene", 0, src.tex);
      kit.bindTex(p, "uB1", 1, T.q0.tex);
      kit.bindTex(p, "uB2", 2, T.e0.tex);
      kit.seti(p, "uMode", MODE_INDEX[mode]);
      kit.set1(p, "uBloomK", bloom);
      kit.set1(p, "uExposure", f.light && c.mode === "glow" ? c.exposure * c.inkGain : c.exposure);
      kit.set2(p, "uRes", kit.size.w, kit.size.h);
      kit.set1(p, "uMaskOn", kit.geo.mask && !traits.fillsStage ? 1 : 0);
      kit.set4(p, "uMask", kit.geo.mask ?? [0, 0, kit.size.w, kit.size.h]);
      kit.set1(p, "uFeather", 90 * kit.size.dpr);
      kit.set1(p, "uVignette", f.ambient ? c.vignette ?? AMBIENT_VIGNETTE : 0);
      kit.drawQuad();
    };
    const candidateFor = (T, kind) => {
      if (current2?.kind === kind) return current2;
      current2?.candidate.dispose();
      const { factory, descriptor } = resolve(kind);
      current2 = { kind, candidate: factory(kit), traits: descriptor };
      for (const target of [T.scene0, T.scene1]) {
        kit.bindTarget(target);
        kit.gl.clearColor(0, 0, 0, 0);
        kit.gl.clear(kit.gl.COLOR_BUFFER_BIT);
      }
      return current2;
    };
    const render = (kind, f) => {
      const T = targets;
      if (!T || gl.isContextLost()) return;
      const { candidate: c, traits } = candidateFor(T, kind);
      const dst = flip ? T.scene1 : T.scene0;
      const src = flip ? T.scene0 : T.scene1;
      kit.bindTarget(dst);
      gl.disable(gl.BLEND);
      if (c.trail) {
        const p = kit.program(TRAIL_PROGRAM);
        gl.useProgram(p.handle);
        kit.set2(p, "uRes", kit.size.w, kit.size.h);
        kit.bindTex(p, "uPrev", 0, src.tex);
        const step = Math.min(3, f.dt * 60);
        kit.set1(p, "uDecay", Math.pow(c.trailDecay ? c.trailDecay(f) : c.trail.decay, step));
        const center = c.trailCenter ? c.trailCenter() : [kit.size.w / 2, kit.size.h / 2];
        kit.set2(p, "uCenter", center[0], center[1]);
        kit.set1(p, "uZoom", Math.pow(c.trailZoom ? c.trailZoom(f) : c.trail.zoom, step));
        kit.set1(p, "uRot", c.trail.rot * step);
        kit.drawQuad();
        flip = 1 - flip;
      } else {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      c.draw(f);
      const mode = f.light ? traits.composite.light : traits.composite.dark;
      const bloom = mode === "image" && c.mode === "glow" ? 0 : c.bloom;
      if (bloom > 0) bloomChain(T, dst, c.mode === "image" ? 0.55 : 0);
      composite(T, dst, traits, mode, bloom, c, f);
    };
    const still = (kind, f) => {
      if (!targets || gl.isContextLost()) return;
      current2?.candidate.dispose();
      current2 = null;
      const rolls = candidateFor(targets, kind).candidate.trail ? 40 : 1;
      for (let i = 0; i < rolls; i++) render(kind, { ...f, t: 14 + i / 60, dt: 1 / 60, still: true });
    };
    const dispose = () => {
      current2?.candidate.dispose();
      current2 = null;
      freeTargets();
      kit.dispose();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    return { fit, render, still, dispose };
  }
  const STILL_POLL_MS = 50;
  const KIND = "mount";
  const STILL_REFUSED = "a still is only drawn before the first tick";
  const BLEND_OF = {
    light: "screen",
    ink: "multiply",
    image: "normal"
  };
  const stageOf = (e, fallback) => e instanceof MountError ? e.stage : fallback;
  const isCanvas = (shot) => typeof shot.getContext === "function";
  function glSurface(init, mount, env, onLost) {
    const canvas = env.createCanvas();
    const gate = createGate(mount.programs, mount.factory);
    const source = {
      factory: gate.factory,
      descriptor: {
        fillsStage: init.fillsStage,
        blend: { light: BLEND_OF[init.composite.light], dark: BLEND_OF[init.composite.dark] },
        composite: init.composite
      }
    };
    const renderer = env.createRenderer(canvas, () => source, deferredCompile);
    if (!renderer) {
      canvas.remove();
      throw new MountError("setup", "WebGL2 is unavailable");
    }
    const onContextLost = (e) => {
      e.preventDefault();
      onLost();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    renderer.fit(init.context.layout);
    const guarded = (run) => {
      if (gate.blocked()) throw new ProgramPending(KIND);
      try {
        run();
      } catch (e) {
        if (e instanceof ProgramPending) gate.hold();
        throw e;
      }
    };
    return {
      nextFrame: gate.nextFrame,
      draw: (f) => guarded(() => renderer.render(KIND, f)),
      still(f) {
        guarded(() => renderer.still(KIND, f));
        return canvas;
      },
      update(ctx, changed) {
        if (changed.layout) renderer.fit(ctx.layout);
      },
      metered: true,
      dispose() {
        canvas.removeEventListener("webglcontextlost", onContextLost);
        try {
          renderer.dispose();
        } finally {
          canvas.remove();
        }
      }
    };
  }
  function rawSurface(init, h) {
    let canvas;
    try {
      canvas = h.setup?.(init.context) || null;
    } catch (e) {
      throw new MountError("setup", errorText(e));
    }
    return {
      nextFrame: () => {
      },
      draw: (f) => h.frame(f),
      still(f) {
        if (!h.still) {
          h.frame(f);
          return canvas;
        }
        return h.still(f) ?? canvas;
      },
      update(ctx, changed) {
        if (changed.layout) h.resize?.(ctx.layout);
        if (changed.settings) h.settings?.(ctx.settings);
        if (changed.light !== void 0 || changed.palette || changed.colors || changed.cover !== void 0) {
          h.theme?.(ctx);
        }
      },
      metered: canvas !== null,
      dispose: () => h.dispose?.()
    };
  }
  function startMount(init, port, mount, env) {
    let ctx = init.context;
    let shown = false;
    let stopped = false;
    let ticked = false;
    let carry = null;
    let stillTimer = null;
    const stills = [];
    const frames = createFrameBuilder();
    let surface = null;
    let transport = null;
    const clearStillTimer = () => {
      if (stillTimer !== null) env.clearTimer(stillTimer);
      stillTimer = null;
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      transport?.dispose();
      clearStillTimer();
      try {
        surface?.dispose();
      } catch {
      }
    };
    const dispose = () => {
      stop();
      port.close();
    };
    const fail = (stage, e) => {
      if (stopped) return;
      for (const id of stills.splice(0)) port.post({ type: "still", id, bitmap: null });
      port.post({ type: "error", stage, message: errorText(e) });
      stop();
    };
    const markShown = () => {
      if (shown) return;
      shown = true;
      port.post({ type: "ready", metered: surface?.metered ?? false });
    };
    const draw = (frame) => {
      try {
        surface?.draw(frame);
      } catch (e) {
        if (!(e instanceof ProgramPending)) fail(stageOf(e, "draw"), e);
        return false;
      }
      markShown();
      return true;
    };
    const refuseStills = () => {
      clearStillTimer();
      for (const id of stills.splice(0)) port.post({ type: "still", id, bitmap: null, error: STILL_REFUSED });
    };
    const serveStills = () => {
      if (stopped || stills.length === 0 || !surface) return;
      let shot;
      try {
        shot = surface.still(frames.rest(ctx));
      } catch (e) {
        if (!(e instanceof ProgramPending)) fail(stageOf(e, "still"), e);
        else if (stillTimer === null) {
          stillTimer = env.setTimer(() => {
            stillTimer = null;
            surface?.nextFrame();
            serveStills();
          }, STILL_POLL_MS);
        }
        return;
      }
      markShown();
      const ids = stills.splice(0);
      if (shot && !isCanvas(shot)) {
        port.post({ type: "still", id: ids[0], bitmap: shot }, [shot]);
        for (const id of ids.slice(1)) port.post({ type: "still", id, bitmap: null });
        return;
      }
      for (const id of ids) {
        if (!shot) {
          port.post({ type: "still", id, bitmap: null });
          continue;
        }
        env.snapshot(shot).then(
          (bitmap) => port.post({ type: "still", id, bitmap }, [bitmap]),
          () => port.post({ type: "still", id, bitmap: null })
        );
      }
    };
    const lose = () => {
      if (stopped) return;
      port.post({ type: "lost" });
      stop();
    };
    port.listen((data) => {
      const msg = readHostMessage(data);
      if (!msg) return;
      if (msg.type === "dispose") return dispose();
      if (stopped) return;
      switch (msg.type) {
        case "tick":
          transport?.onTick(msg);
          break;
        case "update":
          ctx = { ...ctx, ...msg.context };
          try {
            surface?.update(ctx, msg.context);
          } catch (e) {
            fail("draw", e);
          }
          break;
        case "still":
          stills.push(msg.id);
          if (ticked) refuseStills();
          else serveStills();
          break;
      }
    });
    env.prepareRoot();
    try {
      surface = mount.form === "gl" ? glSurface(init, mount, env, lose) : rawSurface(init, mount.handlers);
    } catch (e) {
      fail(stageOf(e, "setup"), e);
      port.close();
      return { dispose };
    }
    transport = createFrameTransport({
      now: env.now,
      requestFrame: env.requestFrame,
      cancelFrame: env.cancelFrame,
      postAck: (seq, ms) => port.post({ type: "ack", seq, ms }),
      step(tick) {
        if (!ticked) {
          ticked = true;
          refuseStills();
        }
        surface?.nextFrame();
        const next = carry ? foldTick(carry, tick) : tick;
        carry = null;
        if (!draw(frames.build(next, Math.min(DT_MAX, next.dt), ctx))) carry = next;
      }
    });
    return { dispose };
  }
  function wrapPort(port) {
    return {
      post: (message, transfer = []) => port.postMessage(message, transfer),
      listen(handler) {
        port.onmessage = (e) => handler(e.data);
      },
      close: () => port.close()
    };
  }
  function browserEnv() {
    return {
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(() => cb()),
      cancelFrame: (id) => cancelAnimationFrame(id),
      setTimer: (cb, ms) => window.setTimeout(cb, ms),
      clearTimer: (id) => window.clearTimeout(id),
      prepareRoot() {
        const root = document.documentElement;
        root.style.colorScheme = "normal";
        root.style.background = "transparent";
        root.style.overflow = "hidden";
        if (document.body) document.body.style.margin = "0";
      },
      createCanvas() {
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block";
        (document.body ?? document.documentElement).appendChild(canvas);
        return canvas;
      },
      snapshot: (canvas) => createImageBitmap(canvas),
      createRenderer
    };
  }
  const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  function relativeLuminance(bytes, i) {
    return 0.2126 * LINEAR[bytes[i]] + 0.7152 * LINEAR[bytes[i + 1]] + 0.0722 * LINEAR[bytes[i + 2]];
  }
  function redness(bytes, i) {
    const r = LINEAR[bytes[i]];
    const g = LINEAR[bytes[i + 1]];
    const b = LINEAR[bytes[i + 2]];
    const total = r + g + b;
    return total > 0 && r / total >= 0.8 ? Math.max(0, (r - g - b) * 320) : 0;
  }
  function popcount(v) {
    let n = v - (v >>> 1 & 1431655765);
    n = (n & 858993459) + (n >>> 2 & 858993459);
    return (n + (n >>> 4) & 252645135) * 16843009 >>> 24;
  }
  const SECOND_FRAMES = 60;
  const FLASH_SPAN_FRAMES = 3;
  const SPAN_SECONDS = FLASH_SPAN_FRAMES / SECOND_FRAMES;
  const WINDOW_STRIDE = 4;
  const AREA_SHARE = 0.25;
  function createFlashTracker(n, step, darkerBelow, second) {
    const last = new Float32Array(n);
    const cur = new Float32Array(n);
    const dir = new Int8Array(n);
    const prev = new Int8Array(n);
    const moves = new Int8Array(n);
    const pendingDown = new Uint8Array(n);
    const pendingPair = new Uint8Array(n);
    const flashAge = new Uint8Array(n).fill(255);
    let ready = false;
    const dark = (x) => darkerBelow === null || x < darkerBelow;
    return {
      moves,
      step(values) {
        if (!ready) {
          last.set(values);
          cur.set(values);
          ready = true;
        }
        for (let i = 0; i < n; i++) {
          const v = values[i];
          let move = 0;
          let trough = 0;
          if (dir[i] === 0) {
            if (v - last[i] >= step) {
              move = 1;
              trough = last[i];
            } else if (last[i] - v >= step) move = -1;
            if (move !== 0) {
              dir[i] = move;
              cur[i] = v;
            }
          } else if (dir[i] === 1) {
            if (v > cur[i]) cur[i] = v;
            else if (cur[i] - v >= step) {
              move = -1;
              last[i] = cur[i];
              cur[i] = v;
              dir[i] = -1;
            }
          } else if (v < cur[i]) cur[i] = v;
          else if (v - cur[i] >= step) {
            move = 1;
            trough = cur[i];
            last[i] = cur[i];
            cur[i] = v;
            dir[i] = 1;
          }
          let counted = 0;
          let flash = false;
          if (move === 0) {
            if (pendingDown[i] === 1 && dir[i] === -1 && dark(cur[i])) {
              counted = -1;
              flash = pendingPair[i] === 1;
              pendingDown[i] = 0;
              pendingPair[i] = 0;
            }
          } else if (move === 1) {
            pendingDown[i] = 0;
            pendingPair[i] = 0;
            const ok = dark(trough);
            if (ok) counted = 1;
            if (prev[i] === -1 && ok) {
              flash = true;
              prev[i] = 0;
            } else prev[i] = ok ? 1 : 0;
          } else {
            const pair = prev[i] === 1;
            pendingDown[i] = 0;
            pendingPair[i] = 0;
            if (dark(v)) {
              counted = -1;
              flash = pair;
            } else {
              pendingDown[i] = 1;
              pendingPair[i] = pair ? 1 : 0;
            }
            prev[i] = pair ? 0 : -1;
          }
          moves[i] = counted;
          flashAge[i] = flash ? 0 : Math.min(255, flashAge[i] + 1);
        }
      },
      flickered(out) {
        let any = false;
        for (let i = 0; i < n; i++) {
          const hit = flashAge[i] < second ? 1 : 0;
          out[i] = hit;
          if (hit) any = true;
        }
        return any;
      }
    };
  }
  function windowCounts(mask, w, h, winW, winH) {
    const sat = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += mask[y * w + x];
        sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
      }
    }
    const out = new Int32Array(windowTotal(w, h, winW, winH));
    let k = 0;
    for (let y = 0; y + winH <= h; y += WINDOW_STRIDE) {
      for (let x = 0; x + winW <= w; x += WINDOW_STRIDE) {
        const a = sat[(y + winH) * (w + 1) + x + winW] - sat[y * (w + 1) + x + winW];
        out[k++] = a - sat[(y + winH) * (w + 1) + x] + sat[y * (w + 1) + x];
      }
    }
    return out;
  }
  function windowTotal(w, h, winW, winH) {
    if (w < winW || h < winH) return 0;
    return (Math.floor((w - winW) / WINDOW_STRIDE) + 1) * (Math.floor((h - winH) / WINDOW_STRIDE) + 1);
  }
  function worstWindow(mask, w, h, winW, winH) {
    return windowCounts(mask, w, h, winW, winH).reduce((a, b) => Math.max(a, b), 0);
  }
  function createFlashMeter(w, h, opts) {
    const { winW, winH } = opts;
    const n = w * h;
    const windows = windowTotal(w, h, winW, winH);
    const second = Math.min(SECOND_FRAMES, Math.max(1, Math.round(opts.rate ?? SECOND_FRAMES)));
    const span = Math.max(1, Math.round(second * SPAN_SECONDS));
    const loMask = second >= 32 ? 4294967295 : 2 ** second - 1;
    const hiMask = second > 32 ? 2 ** (second - 32) - 1 : 0;
    const tracker = createFlashTracker(n, opts.step, opts.darkerBelow, second);
    const up = new Uint8Array(n);
    const down = new Uint8Array(n);
    const flicker = new Uint8Array(n);
    const upRing = Array.from({ length: span }, () => new Int32Array(windows));
    const downRing = Array.from({ length: span }, () => new Int32Array(windows));
    const lastUp = new Int32Array(windows).fill(-1e9);
    const lastDown = new Int32Array(windows).fill(-1e9);
    const pending = new Int8Array(windows);
    const pendingAt = new Int32Array(windows);
    const lo = new Uint32Array(windows);
    const hi = new Uint32Array(windows);
    const needed = Math.ceil(AREA_SHARE * winW * winH);
    let frames = 0;
    let worstRate = 0;
    let worstFlicker = 0;
    const spanCount = (ring, last, k) => {
      let sum = 0;
      for (let j = Math.max(0, frames - span + 1, last[k] + 1); j <= frames; j++) sum += ring[j % span][k];
      return sum;
    };
    const fire = (k, dir) => {
      if (pending[k] === -dir && frames - pendingAt[k] <= second) {
        pending[k] = 0;
        return 1;
      }
      pending[k] = dir;
      pendingAt[k] = frames;
      return 0;
    };
    return {
      frame(values) {
        tracker.step(values);
        let anyUp = false;
        let anyDown = false;
        for (let i = 0; i < n; i++) {
          const m = tracker.moves[i];
          up[i] = m > 0 ? 1 : 0;
          down[i] = m < 0 ? 1 : 0;
          if (m > 0) anyUp = true;
          else if (m < 0) anyDown = true;
        }
        const slot = frames % span;
        upRing[slot] = anyUp ? windowCounts(up, w, h, winW, winH) : new Int32Array(windows);
        downRing[slot] = anyDown ? windowCounts(down, w, h, winW, winH) : new Int32Array(windows);
        for (let k = 0; k < windows; k++) {
          let flash = 0;
          const fireUp = spanCount(upRing, lastUp, k) >= needed;
          const fireDown = spanCount(downRing, lastDown, k) >= needed;
          if (fireUp) lastUp[k] = frames;
          if (fireDown) lastDown[k] = frames;
          const downFirst = pending[k] === 1;
          if (downFirst && fireDown) flash |= fire(k, -1);
          if (fireUp) flash |= fire(k, 1);
          if (!downFirst && fireDown) flash |= fire(k, -1);
          hi[k] = (hi[k] << 1 | lo[k] >>> 31) & hiMask;
          lo[k] = (lo[k] << 1 | flash) >>> 0;
          worstRate = Math.max(worstRate, popcount((lo[k] & loMask) >>> 0) + popcount(hi[k]));
        }
        if (windows > 0 && tracker.flickered(flicker)) {
          worstFlicker = Math.max(worstFlicker, worstWindow(flicker, w, h, winW, winH) / (winW * winH));
        }
        frames++;
      },
      result: () => ({ measured: windows > 0, flashesPerSec: worstRate, flickerShare: worstFlicker })
    };
  }
  const CELL_W = 64;
  const CELL_H = 36;
  const CELL_HZ = 20;
  const CELL_WINDOW_W = 21;
  const CELL_WINDOW_H = 12;
  const LUMA_STEP = 0.1;
  const LUMA_DARKER_BELOW = 0.8;
  const RED_STEP = 20;
  const FLASHES_PER_SEC_LIMIT = 3;
  const RED_FLASHES_LIMIT = 0;
  function createCellMeter() {
    const n = CELL_W * CELL_H;
    const lumaValues = new Float32Array(n);
    const redValues = new Float32Array(n);
    const window2 = { winW: CELL_WINDOW_W, winH: CELL_WINDOW_H, rate: CELL_HZ };
    let series = null;
    let worst = { flashesPerSec: 0, redFlashesPerSec: 0, area: 0 };
    const start2 = () => ({
      luma: createFlashMeter(CELL_W, CELL_H, { ...window2, step: LUMA_STEP, darkerBelow: LUMA_DARKER_BELOW }),
      red: createFlashMeter(CELL_W, CELL_H, { ...window2, step: RED_STEP, darkerBelow: null })
    });
    const tripped = (r) => r.flashesPerSec > FLASHES_PER_SEC_LIMIT || r.redFlashesPerSec > RED_FLASHES_LIMIT;
    return {
      frame(bytes) {
        series ?? (series = start2());
        for (let i = 0; i < n; i++) {
          lumaValues[i] = relativeLuminance(bytes, i * 4);
          redValues[i] = redness(bytes, i * 4);
        }
        series.luma.frame(lumaValues);
        series.red.frame(redValues);
        const luma = series.luma.result();
        worst = {
          flashesPerSec: Math.max(worst.flashesPerSec, luma.flashesPerSec),
          redFlashesPerSec: Math.max(worst.redFlashesPerSec, series.red.result().flashesPerSec),
          area: Math.max(worst.area, luma.flickerShare)
        };
      },
      gap() {
        series = null;
      },
      reading: () => worst,
      tripped: () => tripped(worst)
    };
  }
  const READBACK_RING = 3;
  const STEP_MS = 1e3 / CELL_HZ;
  const DUE_MS = STEP_MS * 0.9;
  const STALE_MS = STEP_MS * 5;
  const BYTES = CELL_W * CELL_H * 4;
  function glReader(gl) {
    const fbo = gl.createFramebuffer();
    const target = gl.createRenderbuffer();
    const ring = [];
    const bytes = new Uint8Array(BYTES);
    let head = 0;
    let tail = 0;
    const keeping = (fn) => {
      const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      const buffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
      try {
        return fn();
      } finally {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
        gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
      }
    };
    keeping(() => {
      gl.bindRenderbuffer(gl.RENDERBUFFER, target);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, CELL_W, CELL_H);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, target);
      for (let i = 0; i < READBACK_RING; i++) {
        const pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, BYTES, gl.STREAM_READ);
        ring.push({ pbo, fence: null, gapBefore: false });
      }
    });
    return {
      start(gapBefore) {
        const slot = ring[head];
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        if (slot.fence || gl.isContextLost() || w === 0 || h === 0) return false;
        keeping(() => {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
          gl.blitFramebuffer(0, 0, w, h, 0, 0, CELL_W, CELL_H, gl.COLOR_BUFFER_BIT, gl.LINEAR);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
          gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        });
        slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        slot.gapBefore = gapBefore;
        gl.flush();
        head = (head + 1) % READBACK_RING;
        return true;
      },
      harvest(deliver) {
        for (let slot = ring[tail]; slot.fence; slot = ring[tail]) {
          const status = gl.clientWaitSync(slot.fence, 0, 0);
          if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break;
          keeping(() => {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
          });
          gl.deleteSync(slot.fence);
          slot.fence = null;
          tail = (tail + 1) % READBACK_RING;
          deliver(bytes, slot.gapBefore);
        }
      },
      dispose() {
        for (const slot of ring) {
          if (slot.fence) gl.deleteSync(slot.fence);
          gl.deleteBuffer(slot.pbo);
        }
        gl.deleteFramebuffer(fbo);
        gl.deleteRenderbuffer(target);
      }
    };
  }
  function scratchReader(canvas, ctx) {
    let ready = null;
    return {
      start(gapBefore) {
        if (ready || canvas.width === 0 || canvas.height === 0) return false;
        ctx.drawImage(canvas, 0, 0, CELL_W, CELL_H);
        const data = ctx.getImageData(0, 0, CELL_W, CELL_H).data;
        ready = { bytes: new Uint8Array(data.buffer, data.byteOffset, data.length), gapBefore };
        return true;
      },
      harvest(deliver) {
        const taken = ready;
        ready = null;
        if (taken) deliver(taken.bytes, taken.gapBefore);
      },
      dispose() {
      }
    };
  }
  function readerFor(canvas, env) {
    const gl = canvas.getContext("webgl2");
    if (gl && !gl.getContextAttributes()?.antialias) return glReader(gl);
    return scratchReader(canvas, env.scratch());
  }
  function createStageMeter(canvas, report, env) {
    const cells = createCellMeter();
    let reader = null;
    let lastAt = null;
    let skipped = false;
    let reported = false;
    const deliver = (bytes, gapBefore) => {
      if (gapBefore) cells.gap();
      cells.frame(bytes);
      if (!reported && cells.tripped()) {
        reported = true;
        report({ ...cells.reading() });
      }
    };
    return {
      frame() {
        try {
          const t = env.now();
          reader ?? (reader = readerFor(canvas, env));
          reader.harvest(deliver);
          if (lastAt !== null && t - lastAt < DUE_MS) return;
          const stale = lastAt !== null && t - lastAt > STALE_MS;
          if (reader.start(skipped || stale)) {
            lastAt = t;
            skipped = false;
          } else skipped = true;
        } catch {
          cells.gap();
          skipped = true;
        }
      },
      dispose() {
        try {
          reader?.dispose();
        } catch {
        }
        reader = null;
      }
    };
  }
  function browserMeterEnv() {
    let ctx = null;
    return {
      now: () => performance.now(),
      scratch() {
        if (!ctx) {
          const scratch = document.createElement("canvas");
          scratch.width = CELL_W;
          scratch.height = CELL_H;
          ctx = scratch.getContext("2d", { willReadFrequently: true });
        }
        return ctx;
      }
    };
  }
  const SHADER_PAGE_PATH = "/_plisto/vis/1/shader.html";
  function isShaderPage(pathname) {
    return pathname === SHADER_PAGE_PATH;
  }
  async function loadShader(href, fetcher) {
    const page = new URL(href);
    const path = page.searchParams.get("shader");
    if (!path) throw new Error("the shader page was opened without a shader path");
    const url = new URL(path, `${page.origin}/`);
    if (url.origin !== page.origin) throw new Error("the shader path must stay on the plugin's origin");
    const res = await fetcher(url.href);
    if (!res.ok) throw new Error(`the shader ${path} could not be read (${res.status})`);
    return shaderForm({ source: await res.text() });
  }
  const BEAT_SLOTS = 4;
  const BEAT_LIFE = 3;
  const FLOOR_GAP = 14;
  const DOT_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aCorner;
uniform vec2 uRes;
uniform float uTime;
// The eased level: the one brightness driver.
uniform float uRms;
uniform float uEnvB;
uniform float uEnvM;
uniform float uEnvH;
// Per beat: its age in seconds and its strength.
uniform vec2 uBeats[${BEAT_SLOTS}];
uniform vec3 uPal[3];
uniform float uLight;
uniform vec4 uCover;
uniform float uRadius;
out vec2 vLocal;
out vec3 vRgb;
out float vAlpha;
out float vHalo;
out float vRpx;
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 pal(float x) { x = clamp(x, 0.0, 2.0); return x < 1.0 ? mix(uPal[0], uPal[1], x) : mix(uPal[1], uPal[2], x - 1.0); }
// A palette color deepened into an ink that holds its hue on a pale ground.
vec3 ink(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return clamp(mix(vec3(l), c, 1.35) * 0.7, 0.0, 1.0); }
vec2 coverCenter() { return uCover.xy + uCover.zw * 0.5; }
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
${HUSH}
// The sum of the beat waves at distance d: each front travels at speed and fades as it ages.
float beatWave(float d, float speed, float width, float fade) {
  float w = 0.0;
  for (int i = 0; i < ${BEAT_SLOTS}; i++) {
    vec2 b = uBeats[i];
    if (b.y <= 0.0) continue;
    float x = (d - b.x * speed) / width;
    w += b.y * exp(-x * x) * exp(-b.x * fade);
  }
  return w;
}
void hide() { vLocal = vec2(0.0); vRgb = vec3(0.0); vAlpha = 0.0; vHalo = 0.0; vRpx = 1.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0); }
void emit(vec2 c, float r, vec3 rgb, float alpha, float halo) {
  float ext = halo > 0.0 ? 2.6 : 1.0 + 1.5 / max(r, 0.5);
  vLocal = aCorner * ext; vRgb = rgb; vAlpha = alpha; vHalo = halo; vRpx = r;
  vec2 p = c + aCorner * ext * r;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;
  const DOT_FS = `#version 300 es
precision highp float;
uniform float uSoft;
in vec2 vLocal;
in vec3 vRgb;
in float vAlpha;
in float vHalo;
in float vRpx;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float e = max(uSoft, 1.4 / max(vRpx, 0.5));
  float core = 1.0 - smoothstep(1.0 - e, 1.0, d);
  float glow = vHalo * exp(-d * d * 0.8) * 0.45;
  if (core <= 0.0 && glow < 0.003) discard;
  float a = core * vAlpha;
  // The halo adds light without coverage, so on the additive dark stage it reads as a soft glow.
  outColor = vec4(vRgb * (a + glow * vAlpha), a);
}`;
  function createDots(kit) {
    const { gl } = kit;
    const corners = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(corners);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const beats = [];
    const packed = new Float32Array(BEAT_SLOTS * 2);
    const begin = (p, f) => {
      for (const b of beats) b.age += f.dt;
      while (beats.length > 0 && beats[beats.length - 1].age > BEAT_LIFE) beats.pop();
      if (f.sig.beat > 0) {
        beats.unshift({ age: 0, strength: f.sig.beat });
        if (beats.length > BEAT_SLOTS) beats.pop();
      }
      packed.fill(0);
      beats.forEach((b, i) => packed.set([b.age, b.strength], i * 2));
      kit.setCommon(p, f);
      const s = f.sig;
      kit.set1(p, "uEnvB", s.bassMotion);
      kit.set1(p, "uEnvM", s.midMotion);
      kit.set1(p, "uEnvH", s.highMotion);
      gl.uniform2fv(kit.uniform(p, "uBeats"), packed);
      kit.set1(p, "uLight", f.light ? 1 : 0);
      kit.set1(p, "uSoft", f.light ? 0.16 : 0.3);
    };
    const draw = (count, glow) => {
      gl.enable(gl.BLEND);
      if (glow) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(corners);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    };
    const floorY = () => kit.geo.floor != null ? kit.geo.floor + FLOOR_GAP * kit.size.dpr : 0;
    const dispose = () => {
      gl.deleteVertexArray(corners);
      gl.deleteBuffer(vbo);
    };
    return { begin, draw, floorY, dispose };
  }
  const BAND_UP_TAU = 0.05;
  const BAND_DOWN_TAU = 0.3;
  const BEAT_UP_TAU = 0.07;
  const BEAT_DOWN_TAU = 0.5;
  const BEAT_TARGET_TAU = 0.22;
  const CYBER_KIT = `
// Smooth inside mask from a signed distance (negative inside), s in css px.
float soft(float sd, float s) { return 1.0 - smoothstep(-s, s, sd); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
vec3 sat(vec3 c, float k) { return mix(vec3(luma(c)), c, k); }
// The cover texture at a unit-square uv, at a chosen blur level.
vec3 coverAt(vec2 uv, float lod) { return textureLod(uCoverTex, clamp(uv, 0.0, 1.0), lod).rgb; }
// A cover palette colour pushed toward neon: more saturated, lifted, capped per channel.
vec3 neon(int i) { vec3 c = uPal[i]; return min(sat(c, 1.45) * 0.95 + 0.07, vec3(0.95)); }
// Tiny silkscreen text: 3x5 glyphs on a 4 px advance, random bits per glyph, n characters from origin o.
float silkText(vec2 p, vec2 o, float n, float seed) {
  vec2 l = p - o;
  if (l.x < 0.0 || l.y < 0.0 || l.y >= 5.0 || l.x >= n * 4.0) return 0.0;
  float ch = floor(l.x / 4.0);
  vec2 g = vec2(floor(mod(l.x, 4.0)), floor(l.y));
  if (g.x > 2.5) return 0.0;
  return step(0.48, hash21(vec2(ch + seed, g.x * 5.0 + g.y + seed * 3.0)));
}
// Eased glitch: rows are cut into slices of varied height and a few slide sideways by amt px, then return. amt is an
// eased envelope, so slices glide; nothing is inverted or flashed.
float sliceShift(float y, float amt, float seed) {
  float band = floor(y / (12.0 + 46.0 * hash11(floor(y / 96.0) + seed)) + seed);
  float on = step(0.70, hash11(band * 1.7 + seed));
  return (hash11(band * 3.1 + seed) - 0.5) * 2.0 * on * amt;
}
// Quiets a colour toward the stage ground behind the text zones.
vec3 hushed(vec3 col, float hu, float k) { return mix(col, uGround, hu * k); }
`;
  function cyberGain(sig, playing) {
    return playing ? sig.drive : 0;
  }
  function cyberBands(eased, sig, gain, dt) {
    for (let i = 0; i < eased.length; i++) {
      const target = gain > 0 ? Math.min(1, sig.bands[i] * Math.min(1.6, gain)) : 0;
      eased[i] = easeEnvelope(eased[i], target, dt, target > eased[i] ? BAND_UP_TAU : BAND_DOWN_TAU);
    }
    return eased;
  }
  function createCyberBeat() {
    return { be: 0, tgt: 0, seed: 1 };
  }
  function cyberBeat(st, sig, gain, dt, rng) {
    st.tgt *= Math.exp(-dt / BEAT_TARGET_TAU);
    if (gain > 0 && sig.beat > 0) {
      if (st.be < 0.2) st.seed = 1 + rng() * 50;
      st.tgt = Math.max(st.tgt, Math.min(1, 0.45 + sig.beat * 0.6) * Math.min(1.3, gain));
    }
    if (gain === 0) st.tgt = 0;
    st.be = easeEnvelope(st.be, st.tgt, dt, st.tgt > st.be ? BEAT_UP_TAU : BEAT_DOWN_TAU);
    return st.be;
  }
  function cyberBandMean(bands, lo, hi) {
    let s = 0;
    for (let i = lo; i < hi; i++) s += bands[i];
    return s / (hi - lo);
  }
  const COSMIC_COMMON = `
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// Sparse stars on a hashed grid, 0..1. Each twinkles on its own slow cycle (4 s or longer) and never goes out.
float stars(vec2 p, float cell, float share, float size) {
  vec2 id = floor(p / cell);
  vec2 f = p / cell - id;
  vec3 r = vec3(hash21(id + 1.7), hash21(id + 9.1), hash21(id + 23.3));
  float d = length((f - (0.2 + 0.6 * r.xy)) * cell);
  float tw = 0.75 + 0.25 * sin(uTime / (4.0 + 5.0 * r.x) + r.y * 40.0);
  return step(r.z, share) * exp(-pow(d / (size * (0.6 + 0.8 * r.x)), 2.0)) * tw * (0.35 + 0.65 * r.y);
}
// A zoom about c: the whole picture swells by k (eased on the script side, so it glides and never shakes).
vec2 zoomAbout(vec2 p, vec2 c, float k) { return c + (p - c) / (1.0 + k); }
// The cover, blurred by lod, read at a stage-space uv.
vec3 coverAt(vec2 uv, float lod) { return textureLod(uCoverTex, uv, lod).rgb; }
// Keeps hue and sets the lightness, so a dark cover still gives a bright tint.
vec3 lift(vec3 c, float l) { return c / max(luma(c), 0.05) * l; }
`;
  const PUNCH_FALL_TAU = 0.55;
  const PUNCH_RISE_TAU = 0.12;
  function createCosmicPunch() {
    return { held: 0, eased: 0 };
  }
  function cosmicPunch(st, beat, dt) {
    st.held = Math.max(st.held * Math.exp(-dt / PUNCH_FALL_TAU), Math.min(1.5, beat));
    st.eased = easeEnvelope(st.eased, st.held, dt, PUNCH_RISE_TAU);
    return st.eased;
  }
  const START_PERIOD = 0.5;
  const MAX_GAP = 2.5;
  const MIN_PERIOD = 0.3;
  const MAX_PERIOD = 1.2;
  const PERIOD_EASE = 0.3;
  const PULL_TAU = 0.5;
  const BEAT_FRESH = 3;
  const LOCK_TAU = 1.5;
  function createBeatClock() {
    return { clock: 0, lastBeat: -1, period: START_PERIOD, beatPos: 0, pull: 0, lock: 0 };
  }
  function stepBeatClock(st, dt, beat, drive) {
    st.clock += dt;
    if (beat > 0) {
      if (st.lastBeat >= 0) {
        const gap = st.clock - st.lastBeat;
        const one = gap / Math.max(1, Math.round(gap / st.period));
        if (gap < MAX_GAP && one > MIN_PERIOD && one < MAX_PERIOD) st.period += (one - st.period) * PERIOD_EASE;
      }
      st.lastBeat = st.clock;
      st.pull -= st.beatPos - Math.round(st.beatPos);
    }
    const corr = st.pull * (1 - Math.exp(-dt / PULL_TAU));
    st.pull -= corr;
    st.beatPos += dt / st.period + corr;
    const locked = drive > 0 && st.lastBeat >= 0 && st.clock - st.lastBeat < BEAT_FRESH ? 1 : 0;
    st.lock = easeEnvelope(st.lock, locked, dt, LOCK_TAU);
  }
  const version = VIS_API;
  let registration = null;
  let waiting = null;
  let mounted = null;
  let framePort = null;
  const bridge = createBridgeClient((msg) => window.parent.postMessage(msg, "*"));
  const call = bridge.call;
  const log = bridge.log;
  const storage = bridge.storage;
  let current = 0;
  const refuse = (port, message) => {
    const visPort = wrapPort(port);
    visPort.post({ type: "error", stage: "setup", message });
    visPort.close();
  };
  function start(init, port, reg) {
    try {
      framePort = wrapPort(port);
      mounted = startMount(init, framePort, reg(init), browserEnv());
    } catch (e) {
      refuse(port, errorText(e));
    }
  }
  function onInit(init, port) {
    const own = ++current;
    mounted?.dispose();
    mounted = null;
    framePort = null;
    waiting?.port.close();
    waiting = null;
    if (init.api !== VIS_API) {
      refuse(port, `runtime api ${VIS_API} cannot serve api ${init.api}`);
      return;
    }
    if (registration) {
      start(init, port, registration);
    } else if (isShaderPage(location.pathname)) {
      loadShader(location.href, (url) => fetch(url)).then(
        (reg) => {
          if (!registration) registration = reg;
          if (own === current) start(init, port, registration);
          else port.close();
        },
        (e) => refuse(port, errorText(e))
      );
    } else {
      waiting = { init, port };
    }
  }
  function register(reg) {
    if (registration) throw new Error("a visualizer frame registers one kind");
    registration = reg;
    if (waiting) {
      const { init, port } = waiting;
      waiting = null;
      start(init, port, reg);
    }
  }
  function shader(spec) {
    register(shaderForm(spec));
  }
  function scene(spec) {
    register(sceneForm(spec));
  }
  function candidate(factory, options) {
    register(candidateForm(factory, options));
  }
  function raw(handlers) {
    register(rawForm(handlers));
  }
  function meter(canvas) {
    const report = (reading) => framePort?.post({ type: "flash", reading });
    return createStageMeter(canvas, report, browserMeterEnv());
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const init = readInit(event.data);
      if (init) {
        if (event.ports[0]) onInit(init, event.ports[0]);
        return;
      }
      const data = event.data;
      if (data && typeof data === "object" && data.plisto === BRIDGE_PROTOCOL) bridge.handle(data);
    });
  }
  exports.BAND_COUNT = BAND_COUNT;
  exports.BEAT_MAX_PER_SEC = BEAT_MAX_PER_SEC;
  exports.BEAT_MIN_GAP_SECS = BEAT_MIN_GAP_SECS;
  exports.COSMIC_COMMON = COSMIC_COMMON;
  exports.COZY_PRELUDE = COZY_PRELUDE;
  exports.CYBER_KIT = CYBER_KIT;
  exports.DOT_FS = DOT_FS;
  exports.DOT_PRELUDE = DOT_PRELUDE;
  exports.FINE_BAND_COUNT = FINE_BAND_COUNT;
  exports.FLUID_PRELUDE = FLUID_PRELUDE;
  exports.FS_VS = FS_VS;
  exports.HUSH = HUSH;
  exports.HUSH_SLOTS = HUSH_SLOTS;
  exports.LEVEL_TAU = LEVEL_TAU;
  exports.MOTION_ATTACK_SECS = MOTION_ATTACK_SECS;
  exports.PRELUDE = PRELUDE;
  exports.REACTIVITY_PROFILES = REACTIVITY_PROFILES;
  exports.RING_SLOTS = RING_SLOTS;
  exports.SCENE_PRELUDE = SCENE_PRELUDE;
  exports.SWELL_TAU = SWELL_TAU;
  exports.admitBeat = admitBeat;
  exports.call = call;
  exports.candidate = candidate;
  exports.clamp01 = clamp01;
  exports.cosmicPunch = cosmicPunch;
  exports.createBeatClock = createBeatClock;
  exports.createCosmicPunch = createCosmicPunch;
  exports.createCoverTexture = createCoverTexture;
  exports.createCyberBeat = createCyberBeat;
  exports.createDots = createDots;
  exports.createRings = createRings;
  exports.createRng = createRng;
  exports.cyberBandMean = cyberBandMean;
  exports.cyberBands = cyberBands;
  exports.cyberBeat = cyberBeat;
  exports.cyberGain = cyberGain;
  exports.easeEnvelope = easeEnvelope;
  exports.log = log;
  exports.meter = meter;
  exports.motionEnvelope = motionEnvelope;
  exports.raw = raw;
  exports.restSignal = restSignal;
  exports.restingBands = restingBands;
  exports.scene = scene;
  exports.setFluid = setFluid;
  exports.setScene = setScene;
  exports.settingUniform = settingUniform;
  exports.shader = shader;
  exports.smoothBands = smoothBands;
  exports.stepBeatClock = stepBeatClock;
  exports.storage = storage;
  exports.version = version;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({});
