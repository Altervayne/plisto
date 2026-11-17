/*
 * Stand-in for a UI plugin page: answers every ping over the port with a pong that echoes the page's own
 * send stamp, so the page can time the round trip.
 */
(function (root) {
  "use strict";

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (data && data.type === "ping") {
        port.postMessage({ type: "pong", seq: data.seq, sent: data.sent });
      }
    };
  });
})(globalThis);
