/*
 * On `lose`, makes a WebGL2 context, loses it through WEBGL_lose_context, then restores it, and reports
 * the events the canvas saw and the context's state after each step as one `lose-result`.
 */
(function (root) {
  "use strict";

  var SETTLE_MS = 250;

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (!data || data.type !== "lose") return;

      var canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      var gl = canvas.getContext("webgl2");
      if (!gl) {
        port.postMessage({ type: "lose-result", refused: true });
        return;
      }
      var ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) {
        port.postMessage({ type: "lose-result", noExtension: true });
        return;
      }

      var events = [];
      canvas.addEventListener("webglcontextlost", function (e) {
        e.preventDefault();
        events.push("lost");
      });
      canvas.addEventListener("webglcontextrestored", function () {
        events.push("restored");
      });

      ext.loseContext();
      setTimeout(function () {
        var lostAfterLose = gl.isContextLost();
        ext.restoreContext();
        setTimeout(function () {
          port.postMessage({
            type: "lose-result",
            events: events,
            lostAfterLose: lostAfterLose,
            lostAfterRestore: gl.isContextLost(),
          });
        }, SETTLE_MS);
      }, SETTLE_MS);
    };
  });
})(globalThis);
