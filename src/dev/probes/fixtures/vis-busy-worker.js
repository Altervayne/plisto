/*
 * A frame whose spin runs in a blob worker while its main thread stays free to answer pings. A refused
 * worker is reported as `worker-error` with the browser's message.
 */
(function (root) {
  "use strict";

  function reason(error) {
    return String((error && error.message) || error || "worker error");
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (!data) return;
      if (data.type === "ping") {
        port.postMessage({ type: "pong", seq: data.seq, sent: data.sent });
        return;
      }
      if (data.type !== "busy") return;
      try {
        var source =
          "var end = Date.now() + " + Number(data.ms) + ";" +
          "while (Date.now() < end) {}" +
          "self.postMessage('done');";
        var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        var worker = new Worker(url);
        worker.onmessage = function () {
          worker.terminate();
          URL.revokeObjectURL(url);
          port.postMessage({ type: "busy-end" });
        };
        worker.onerror = function (failure) {
          port.postMessage({ type: "worker-error", message: reason(failure) });
        };
        port.postMessage({ type: "busy-start" });
      } catch (error) {
        port.postMessage({ type: "worker-error", message: reason(error) });
      }
    };
  });
})(globalThis);
