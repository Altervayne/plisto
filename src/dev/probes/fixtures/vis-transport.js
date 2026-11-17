/*
 * The consumer end of the transport stand-in. Ticks that arrive between two consumptions fold into one
 * held tick (dt sums, beat, flux and kick keep the max, the rest takes the latest); the consumer takes the
 * held tick on its own animation frame, at most about 30 times a second, and acknowledges it. Modes:
 * "run" consumes and acknowledges, "block" also stalls 40 ms per consumed tick, "sink" only counts.
 */
(function (root) {
  "use strict";

  var CONSUME_GAP_MS = 32;
  var BLOCK_MS = 40;

  var mode = "run";
  var held = null;
  var lastConsume = 0;
  var totals;
  // The last tick this end acknowledged: a tick's distance past it is what the sender had outstanding.
  var ackedSeq = 0;

  function reset() {
    held = null;
    ackedSeq = 0;
    totals = { received: 0, beatsSeen: 0, dtSum: 0, consumed: 0, beatFrames: 0, consumedDt: 0, maxBehind: 0 };
  }
  reset();

  function epoch() {
    return root.performance.timeOrigin + root.performance.now();
  }

  function receive(tick) {
    totals.received++;
    totals.beatsSeen += tick.nBeats;
    totals.dtSum += tick.dt;
    if (mode === "sink") return;
    totals.maxBehind = Math.max(totals.maxBehind, tick.seq - ackedSeq);
    if (held) {
      held.dt += tick.dt;
      held.beat = Math.max(held.beat, tick.beat);
      held.flux = Math.max(held.flux, tick.flux);
      held.kick = Math.max(held.kick, tick.kick);
      held.level = tick.level;
      held.seq = tick.seq;
      held.sentEpoch = tick.sentEpoch;
      held.rxEpoch = epoch();
    } else {
      held = { seq: tick.seq, dt: tick.dt, beat: tick.beat, flux: tick.flux, kick: tick.kick, level: tick.level, sentEpoch: tick.sentEpoch, rxEpoch: epoch() };
    }
  }

  root.probeReady.then(function (port) {
    function frame(now) {
      if (held && mode !== "sink" && now - lastConsume >= CONSUME_GAP_MS) {
        lastConsume = now;
        if (mode === "block") {
          var start = root.performance.now();
          while (root.performance.now() - start < BLOCK_MS) {}
        }
        totals.consumed++;
        totals.consumedDt += held.dt;
        if (held.beat > 0) totals.beatFrames++;
        ackedSeq = held.seq;
        port.postMessage({ type: "ack", seq: held.seq, sentEpoch: held.sentEpoch, rxEpoch: held.rxEpoch });
        held = null;
      }
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);

    port.onmessage = function (event) {
      var data = event.data;
      if (!data) return;
      if (data.type === "tick") receive(data);
      else if (data.type === "mode") mode = data.mode;
      else if (data.type === "reset") reset();
      else if (data.type === "report") port.postMessage({ type: "report", totals: totals });
    };
  });
})(globalThis);
