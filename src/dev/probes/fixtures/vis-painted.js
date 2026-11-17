/*
 * Answers a `paint` request over the port with `painted` after two animation frames, so the page knows the
 * frame has rendered its document before it captures.
 */
(function (root) {
  "use strict";

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var message = event.data;
      if (!message || message.type !== "paint") return;
      root.requestAnimationFrame(function () {
        root.requestAnimationFrame(function () {
          port.postMessage({ type: "painted", id: message.id });
        });
      });
    };
  });
})(globalThis);
