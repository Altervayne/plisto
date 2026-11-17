/*
 * Counts this frame's own animation callbacks. The page asks for the running total over the port and
 * works out the rate per phase from the totals and the frame's own clock, so the frame needs no timer.
 */
(function (root) {
  "use strict";

  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var count = 0;

  function frame() {
    count++;
    ctx.fillStyle = "hsl(" + ((count * 3) % 360) + ", 70%, 50%)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    root.requestAnimationFrame(frame);
  }
  root.requestAnimationFrame(frame);

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (data && data.type === "sample") {
        port.postMessage({ type: "sample", id: data.id, count: count, now: root.performance.now() });
      }
    };
  });
})(globalThis);
