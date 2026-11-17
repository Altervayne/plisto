/*
 * On `compile`, builds a WebGL2 context, compiles and links the posted programs (polling
 * KHR_parallel_shader_compile when the browser has it), draws one full-screen pass with the first program
 * that linked, waits for the next animation frame and reads one pixel back so the draw has finished, then
 * reports `first-frame`. The page times the whole span from the frame's insertion.
 */
(function (root) {
  "use strict";

  var SIZE = [640, 360];
  var TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

  function build(gl, program, source) {
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, source.vs);
    gl.compileShader(vs);
    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, source.fs);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    return { vs: vs, fs: fs };
  }

  function failureOf(gl, program, shaders, name) {
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    var log = gl.getProgramInfoLog(program) || gl.getShaderInfoLog(shaders.fs) || gl.getShaderInfoLog(shaders.vs) || "";
    return name + ": " + String(log).slice(0, 200);
  }

  function whenLinked(gl, ext, programs, done) {
    var poll = function () {
      var pending = ext
        ? programs.some(function (p) {
            return !gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR);
          })
        : false;
      if (pending) setTimeout(poll, 0);
      else done();
    };
    poll();
  }

  function drawOnce(gl, program) {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, TRIANGLE, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, SIZE[0], SIZE[1]);
    gl.useProgram(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function compile(port, data) {
    var started = performance.now();
    var canvas = document.createElement("canvas");
    canvas.width = SIZE[0];
    canvas.height = SIZE[1];
    document.body.appendChild(canvas);
    var gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) {
      port.postMessage({ type: "first-frame", refused: true });
      return;
    }
    var ext = data.parallel ? gl.getExtension("KHR_parallel_shader_compile") : null;
    var sources = data.programs;
    var programs = [];
    var shaders = [];
    for (var i = 0; i < sources.length; i++) {
      var program = gl.createProgram();
      shaders.push(build(gl, program, sources[i]));
      programs.push(program);
    }

    whenLinked(gl, ext, programs, function () {
      var linkedAt = performance.now();
      var failed = [];
      var first = null;
      for (var i = 0; i < programs.length; i++) {
        var failure = failureOf(gl, programs[i], shaders[i], sources[i].name);
        if (failure) failed.push(failure);
        else if (first === null) first = programs[i];
      }
      if (first !== null) drawOnce(gl, first);
      requestAnimationFrame(function () {
        var pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        port.postMessage({
          type: "first-frame",
          parallel: ext !== null,
          compileMs: linkedAt - started,
          totalMs: performance.now() - started,
          programs: programs.length,
          failed: failed,
        });
      });
    });
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (data && data.type === "compile") compile(port, data);
    };
  });
})(globalThis);
