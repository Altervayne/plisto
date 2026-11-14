/*
 * Tap meter page script. The Ping buttons call the plugin's own program through Plisto and show the
 * answer or the error code. The meters draw the `levels` page events the program sends ten times a
 * second while this page is open. Each bar eases toward its latest level, so it moves smoothly between
 * events and never jumps or blinks.
 */
(function () {
  "use strict";

  var plisto = window.plisto;
  // The level shown at the left edge of a bar; quieter reads as empty.
  var FLOOR_DB = -60;
  // How quickly a bar closes on its target, in seconds: about two thirds of the way in this time.
  var EASE_SECONDS = 0.12;

  // One entry per channel: its two bars, and the shown and target fractions of each.
  var meters = [];
  var frame = null;
  var lastTime = null;

  function $(id) {
    return document.getElementById(id);
  }

  function fraction(db) {
    if (typeof db !== "number" || !isFinite(db)) return 0;
    return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
  }

  function bar(className) {
    var el = document.createElement("div");
    el.className = className;
    return el;
  }

  function build(channels) {
    var host = $("meters");
    host.textContent = "";
    meters = [];
    for (var c = 0; c < channels; c++) {
      var label = document.createElement("span");
      label.className = "meter-label";
      label.textContent = "ch " + (c + 1);
      var track = bar("meter");
      var peak = bar("meter-peak");
      var rms = bar("meter-rms");
      track.appendChild(peak);
      track.appendChild(rms);
      host.appendChild(label);
      host.appendChild(track);
      meters.push({ peak: peak, rms: rms, shown: [0, 0], target: [0, 0] });
    }
  }

  function draw(time) {
    var dt = lastTime === null ? 0 : (time - lastTime) / 1000;
    lastTime = time;
    var k = 1 - Math.exp(-dt / EASE_SECONDS);
    var moving = false;
    for (var i = 0; i < meters.length; i++) {
      var m = meters[i];
      for (var j = 0; j < 2; j++) {
        m.shown[j] += (m.target[j] - m.shown[j]) * k;
        if (Math.abs(m.target[j] - m.shown[j]) > 0.001) moving = true;
        else m.shown[j] = m.target[j];
      }
      m.peak.style.transform = "scaleX(" + m.shown[0] + ")";
      m.rms.style.transform = "scaleX(" + m.shown[1] + ")";
    }
    if (moving) {
      frame = requestAnimationFrame(draw);
    } else {
      frame = null;
      lastTime = null;
    }
  }

  function onLevels(data) {
    var peak = data && Array.isArray(data.peak_db) ? data.peak_db : [];
    var rms = data && Array.isArray(data.rms_db) ? data.rms_db : [];
    if (peak.length > 0 && peak.length !== meters.length) build(peak.length);
    for (var i = 0; i < meters.length; i++) {
      meters[i].target[0] = fraction(peak[i]);
      meters[i].target[1] = fraction(rms[i]);
    }
    var transport = data && typeof data.transport === "string" ? data.transport : "no feed yet";
    $("levels-note").textContent =
      meters.length === 0 ? "No audio in the tap (" + transport + ")." : "Playback: " + transport + ".";
    if (frame === null) frame = requestAnimationFrame(draw);
  }

  function call(name) {
    var started = Date.now();
    $("answer").textContent = "Waiting for " + name + "...";
    plisto.plugin.call(name, {}).then(
      function (result) {
        var ms = Date.now() - started;
        $("answer").textContent = name + " answered " + JSON.stringify(result) + " in " + ms + " ms";
      },
      function (e) {
        var ms = Date.now() - started;
        var reason = e.reason ? " (" + e.reason + ")" : "";
        // A plugin_error carries the program's own message.
        var said = e.code === "plugin_error" ? ": " + e.message : "";
        $("answer").textContent = name + " failed: " + e.code + reason + said + " after " + ms + " ms";
      },
    );
  }

  plisto.onPluginEvent("levels", onLevels);
  $("ping").addEventListener("click", function () {
    call("ping");
  });
  $("unknown").addEventListener("click", function () {
    call("missing");
  });
})();
