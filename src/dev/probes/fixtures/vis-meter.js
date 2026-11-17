/*
 * A stand-in for a pixel meter: each step downsamples the drawn scene to 64 x 36 cells in a shader (a
 * grid of taps per cell, written as luminance), reads the cells back asynchronously through a ring of
 * pixel-pack buffers guarded by fences, and reduces finished readbacks on the CPU. Steps run in batches
 * inside one animation frame and each batch is timed as a whole, so a step below the clock's resolution
 * still has a mean. The scene draw is outside the timed span.
 */
(function (root) {
  "use strict";

  var CELLS_X = 64;
  var CELLS_Y = 36;
  var CELL_BYTES = CELLS_X * CELLS_Y * 4;
  var RING = 16;
  var WARMUP_FRAMES = 30;

  var FULLSCREEN_VS = "#version 300 es\n" +
    "void main() {\n" +
    "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n" +
    "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n" +
    "}\n";

  var SCENE_FS = "#version 300 es\n" +
    "precision highp float;\n" +
    "uniform vec2 uSize;\n" +
    "uniform float uTime;\n" +
    "out vec4 o;\n" +
    "void main() {\n" +
    "  vec2 uv = gl_FragCoord.xy / uSize;\n" +
    "  float bars = 0.5 + 0.5 * sin(uv.x * 40.0 + uTime * 2.0);\n" +
    "  float band = smoothstep(0.0, 1.0, uv.y + 0.3 * sin(uTime + uv.x * 6.0));\n" +
    "  o = vec4(bars * band, uv.x * 0.6, 0.4 + 0.4 * sin(uTime), 1.0);\n" +
    "}\n";

  var METER_FS = "#version 300 es\n" +
    "precision highp float;\n" +
    "uniform sampler2D uScene;\n" +
    "out vec4 o;\n" +
    "void main() {\n" +
    "  ivec2 size = textureSize(uScene, 0);\n" +
    "  ivec2 cell = ivec2(gl_FragCoord.xy);\n" +
    "  ivec2 span = ivec2(size.x / " + CELLS_X + ", size.y / " + CELLS_Y + ");\n" +
    "  ivec2 origin = cell * span;\n" +
    "  float sum = 0.0;\n" +
    "  for (int y = 0; y < 8; y++) {\n" +
    "    for (int x = 0; x < 8; x++) {\n" +
    "      ivec2 tap = origin + ivec2(x, y) * span / 8;\n" +
    "      vec3 c = texelFetch(uScene, tap, 0).rgb;\n" +
    "      sum += dot(c, vec3(0.2126, 0.7152, 0.0722));\n" +
    "    }\n" +
    "  }\n" +
    "  o = vec4(sum / 64.0, 0.0, 0.0, 1.0);\n" +
    "}\n";

  function describeError(e) {
    return (e && e.name ? e.name : "Error") + ": " + (e && e.message ? e.message : String(e));
  }

  function observeClockStep() {
    var smallest = Infinity;
    for (var i = 0; i < 20; i++) {
      var first = root.performance.now();
      var next = first;
      for (var spin = 0; spin < 1000000 && next === first; spin++) next = root.performance.now();
      if (next !== first && next - first < smallest) smallest = next - first;
    }
    return isFinite(smallest) ? smallest : 0;
  }

  function compile(gl, vsSource, fsSource) {
    function shader(type, source) {
      var s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  }

  function target(gl, width, height) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture: texture, fbo: fbo };
  }

  function start(port, width, height, frames, batch) {
    var canvas = document.getElementById("c");
    canvas.width = width;
    canvas.height = height;
    var gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) {
      port.postMessage({ type: "result", error: "no WebGL2 context" });
      return;
    }
    var scene;
    var meter;
    var sceneTarget;
    var smallTarget;
    try {
      scene = compile(gl, FULLSCREEN_VS, SCENE_FS);
      meter = compile(gl, FULLSCREEN_VS, METER_FS);
      sceneTarget = target(gl, width, height);
      smallTarget = target(gl, CELLS_X, CELLS_Y);
    } catch (e) {
      port.postMessage({ type: "result", error: describeError(e) });
      return;
    }
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var sceneSize = gl.getUniformLocation(scene, "uSize");
    var sceneTime = gl.getUniformLocation(scene, "uTime");
    var meterScene = gl.getUniformLocation(meter, "uScene");

    var ring = [];
    for (var r = 0; r < RING; r++) {
      var buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, CELL_BYTES, gl.STREAM_READ);
      ring.push({ buffer: buffer, sync: null });
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    var cells = new Uint8Array(CELL_BYTES);
    var previous = new Float32Array(CELLS_X * CELLS_Y);
    var counters = { steps: 0, skipped: 0, completed: 0, sink: 0 };

    function reduce() {
      var sum = 0;
      var max = 0;
      var change = 0;
      for (var i = 0; i < CELLS_X * CELLS_Y; i++) {
        var lum = cells[i * 4] / 255;
        sum += lum;
        if (lum > max) max = lum;
        change += Math.abs(lum - previous[i]);
        previous[i] = lum;
      }
      counters.sink += sum + max + change;
    }

    function poll() {
      for (var i = 0; i < ring.length; i++) {
        var slot = ring[i];
        if (!slot.sync) continue;
        var status = gl.clientWaitSync(slot.sync, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, cells);
          gl.deleteSync(slot.sync);
          slot.sync = null;
          counters.completed++;
          reduce();
        }
      }
    }

    function step() {
      counters.steps++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, smallTarget.fbo);
      gl.viewport(0, 0, CELLS_X, CELLS_Y);
      gl.useProgram(meter);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTarget.texture);
      gl.uniform1i(meterScene, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var free = null;
      for (var i = 0; i < ring.length; i++) {
        if (!ring[i].sync) {
          free = ring[i];
          break;
        }
      }
      if (free) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, free.buffer);
        gl.readPixels(0, 0, CELLS_X, CELLS_Y, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        free.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      } else {
        counters.skipped++;
      }
      poll();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }

    function drawScene(time) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.fbo);
      gl.viewport(0, 0, width, height);
      gl.useProgram(scene);
      gl.uniform2f(sceneSize, width, height);
      gl.uniform1f(sceneTime, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sceneTarget.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    var batchMs = [];
    var frame = 0;
    function tick(now) {
      drawScene(now / 1000);
      if (frame >= WARMUP_FRAMES) {
        var t0 = root.performance.now();
        for (var i = 0; i < batch; i++) step();
        batchMs.push(root.performance.now() - t0);
      }
      frame++;
      if (batchMs.length < frames) {
        root.requestAnimationFrame(tick);
        return;
      }
      var info = gl.getExtension("WEBGL_debug_renderer_info");
      port.postMessage({
        type: "result",
        width: width,
        height: height,
        batch: batch,
        batchMs: batchMs,
        step: observeClockStep(),
        steps: counters.steps,
        skipped: counters.skipped,
        completed: counters.completed,
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown",
      });
    }
    root.requestAnimationFrame(tick);
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var d = event.data;
      if (d && d.type === "run") start(port, d.width, d.height, d.frames, d.batch);
    };
  });
})(globalThis);
