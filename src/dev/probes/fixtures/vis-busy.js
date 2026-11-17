/*
 * A frame that can be told to spin its main thread. `busy` loops for the given milliseconds and reports
 * both ends over the port; `ping` is answered with a pong while the thread is free.
 */
(function (root) {
  "use strict";

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (!data) return;
      if (data.type === "ping") {
        port.postMessage({ type: "pong", seq: data.seq, sent: data.sent });
      } else if (data.type === "busy") {
        port.postMessage({ type: "busy-start" });
        var end = Date.now() + Number(data.ms);
        while (Date.now() < end) {
          // Spin.
        }
        port.postMessage({ type: "busy-end" });
      }
    };
  });
})(globalThis);
