/*
 * Two jobs over the port. "canvas": receive a transferred OffscreenCanvas and draw into it. "stream":
 * draw a 1920 x 1080 canvas each animation frame and post it to the page as a transferred ImageBitmap,
 * holding at most two bitmaps unacknowledged.
 */
(function (root) {
  "use strict";

  var STREAM_W = 1920;
  var STREAM_H = 1080;
  var MAX_IN_FLIGHT = 2;

  function describeError(e) {
    return (e && e.name ? e.name : "Error") + ": " + (e && e.message ? e.message : String(e));
  }

  function drawTransferred(port, canvas) {
    var info = {
      type: "drawn",
      offscreenType: typeof root.OffscreenCanvas,
      arrived: Object.prototype.toString.call(canvas),
      ok: false,
      error: "",
    };
    try {
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(200, 80, 40)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(40, 80, 220, 0.5)";
      ctx.fillRect(0, 0, canvas.width / 2, canvas.height);
      if (typeof ctx.commit === "function") ctx.commit();
      info.ok = true;
    } catch (e) {
      info.error = describeError(e);
    }
    port.postMessage(info);
  }

  function startStream(port) {
    var canvas = document.createElement("canvas");
    canvas.width = STREAM_W;
    canvas.height = STREAM_H;
    var ctx = canvas.getContext("2d");
    var inFlight = 0;
    var seq = 0;
    var running = true;

    port.addEventListener("message", function (event) {
      var data = event.data;
      if (data && data.type === "bitmap-ack") inFlight = Math.max(0, inFlight - 1);
      if (data && data.type === "stop") running = false;
    });

    function frame() {
      if (!running) return;
      if (inFlight < MAX_IN_FLIGHT) {
        var hue = (seq * 7) % 360;
        ctx.fillStyle = "hsl(" + hue + ", 70%, 45%)";
        ctx.fillRect(0, 0, STREAM_W, STREAM_H);
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.fillRect((seq * 13) % STREAM_W, 0, 64, STREAM_H);
        inFlight++;
        var n = seq++;
        root.createImageBitmap(canvas).then(
          function (bmp) {
            port.postMessage({ type: "bitmap", seq: n, bmp: bmp }, [bmp]);
          },
          function (e) {
            inFlight--;
            port.postMessage({ type: "stream-error", error: describeError(e) });
            running = false;
          },
        );
      }
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (!data) return;
      if (data.type === "canvas") drawTransferred(port, data.canvas);
      else if (data.type === "stream") startStream(port);
    };
  });
})(globalThis);
