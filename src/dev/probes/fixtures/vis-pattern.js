/*
 * Frame side of the blend pattern. Holds a WebGL2 canvas and a Canvas 2D canvas, each as large as the whole
 * pattern; a `show` message picks one, redraws it and answers `shown` after two animation frames.
 */
(function (root) {
  "use strict";

  var pattern = root.probePattern;
  var size = pattern.size();
  var canvases = { webgl: document.getElementById("gl"), "2d": document.getElementById("c2d") };

  function show(message) {
    var canvas = canvases[message.api];
    if (!canvas) return false;
    canvases.webgl.style.display = "none";
    canvases["2d"].style.display = "none";
    var width = Math.round(size.width * message.scale);
    var height = Math.round(size.height * message.scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = size.width + "px";
    canvas.style.height = size.height + "px";
    canvas.style.display = "block";
    var ctx = message.api === "webgl" ? pattern.drawWebGL(canvas, message.scale) : pattern.draw2D(canvas, message.scale);
    return ctx !== null;
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
