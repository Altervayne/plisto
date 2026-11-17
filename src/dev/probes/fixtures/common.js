/*
 * The frame side of the probe handshake. The page posts one message carrying a MessagePort once the
 * document has loaded; this script keeps the port, answers `ready` over it, and exposes both so a fixture
 * can talk to the page: `probePort` and the promise `probeReady`. `probeHello()` is the console check.
 */
(function (root) {
  "use strict";

  root.probeReady = new Promise(function (resolve) {
    root.addEventListener("message", function onMessage(event) {
      var data = event.data;
      if (!data || data.probe !== "port" || !event.ports || !event.ports[0]) return;
      root.removeEventListener("message", onMessage);
      root.probePort = event.ports[0];
      root.probePort.postMessage({ type: "ready", host: root.location.host });
      resolve(root.probePort);
    });
  });

  root.probeHello = function probeHello() {
    return "probe frame on " + root.location.host;
  };
})(globalThis);
