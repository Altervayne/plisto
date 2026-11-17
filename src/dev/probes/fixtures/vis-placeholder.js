/*
 * Frame side of the offscreen-canvas shape. The page transfers one OffscreenCanvas per context type over the
 * port; a `draw` message draws the whole pattern into the named one and answers `drawn` after two animation
 * frames. The frame shows nothing itself.
 */
(function (root) {
  "use strict";

  var pattern = root.probePattern;
  var targets = {};

  function draw(message) {
    var target = targets[message.api];
    if (!target) return false;
    var ctx = message.api === "webgl" ? pattern.drawWebGL(target, message.scale) : pattern.draw2D(target, message.scale);
    return ctx !== null;
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var message = event.data;
      if (!message) return;
      if (message.type === "canvas") {
        targets[message.api] = message.canvas;
        port.postMessage({ type: "received", id: message.id, api: message.api });
      } else if (message.type === "draw") {
        var ok = draw(message);
        root.requestAnimationFrame(function () {
          root.requestAnimationFrame(function () {
            port.postMessage({ type: "drawn", id: message.id, ok: ok });
          });
        });
      }
    };
  });
})(globalThis);
