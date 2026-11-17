/*
 * Frame side of the solid canvas control: fills the whole frame with one opaque color through WebGL2 or
 * Canvas 2D, on the `show` message, and answers `shown` after two animation frames.
 */
(function (root) {
  "use strict";

  var RGB = [58, 110, 165];
  var canvases = { webgl: document.getElementById("gl"), "2d": document.getElementById("c2d") };

  function show(message) {
    var canvas = canvases[message.api];
    if (!canvas) return false;
    canvases.webgl.style.display = "none";
    canvases["2d"].style.display = "none";
    canvas.width = Math.round(root.innerWidth * message.scale);
    canvas.height = Math.round(root.innerHeight * message.scale);
    canvas.style.display = "block";
    if (message.api === "webgl") {
      var gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) return false;
      gl.clearColor(RGB[0] / 255, RGB[1] / 255, RGB[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return true;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = "rgb(" + RGB[0] + "," + RGB[1] + "," + RGB[2] + ")";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return true;
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var message = event.data;
      if (!message || message.type !== "show") return;
      var ok = show(message);
      root.requestAnimationFrame(function () {
        root.requestAnimationFrame(function () {
          port.postMessage({ type: "shown", id: message.id, ok: ok });
        });
      });
    };
  });
})(globalThis);
