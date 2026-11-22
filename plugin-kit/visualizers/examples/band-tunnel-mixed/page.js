/*
 * The control page of the band tunnel. It sends the accent when a button is clicked and a pulse on demand,
 * and shows the energy the tunnel reports. Sends are spaced SEND_GAP_MS apart, far inside the rate limit.
 */
(function () {
  "use strict";

  var SILENCE_MS = 2000;
  var SEND_GAP_MS = 400;
  var READY = "Select the Band tunnel (live) in the Player and play a track.";
  var lastSeen = 0;
  var lastSend = 0;
  var accent = "default";

  function $(id) {
    return document.getElementById(id);
  }

  function status(text) {
    $("status").textContent = text;
  }

  function send(data) {
    try {
      window.plisto.visualizers.send(data);
    } catch (err) {
      status("Could not send: " + err.message);
    }
  }

  // Both kinds of click share one gap.
  function spaced() {
    var now = Date.now();
    if (now - lastSend < SEND_GAP_MS) return false;
    lastSend = now;
    return true;
  }

  function isQuiet() {
    return !lastSeen || Date.now() - lastSeen > SILENCE_MS;
  }

  function markAccent() {
    var buttons = document.querySelectorAll("[data-accent]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].dataset.accent === accent));
    }
  }

  function sendAccent() {
    send({ type: "accent", value: accent });
  }

  // A report is the truth about the tunnel: when its accent differs from the choice, send the choice again.
  function showReport(data) {
    lastSeen = Date.now();
    status(READY);
    $("fill").style.width = Math.round(data.value * 100) + "%";
    var shown = typeof data.accent === "string" ? data.accent : "unknown";
    $("report").textContent = "Energy " + data.value.toFixed(2) + ", accent " + shown + ".";
    if (shown !== accent && spaced()) sendAccent();
  }

  // The tunnel sends nothing while hidden or paused, so a quiet channel is not an error.
  function checkSilence() {
    if (lastSeen && isQuiet()) {
      $("report").textContent = "The tunnel is quiet: not on the stage, or paused.";
    }
  }

  function onMessage(data) {
    if (!data) return;
    // The tunnel starts at the default accent and says hello; the answer is the page's choice.
    if (data.type === "hello") sendAccent();
    else if (data.type === "energy" && typeof data.value === "number") showReport(data);
  }

  function start() {
    if (!window.plisto.has("channel.send")) {
      status("This Plisto has no page channel, so the tunnel cannot be tuned from here.");
      return;
    }
    status(READY);
    window.plisto.visualizers.onMessage(onMessage);
    $("accents").addEventListener("click", function (event) {
      var next = event.target.dataset && event.target.dataset.accent;
      if (!next || next === accent || !spaced()) return;
      accent = next;
      markAccent();
      sendAccent();
    });
    $("pulse").addEventListener("click", function () {
      if (isQuiet()) {
        status("Pulse ignored: the tunnel is paused or not on the stage.");
        return;
      }
      if (spaced()) send({ type: "pulse" });
    });
    markAccent();
    setInterval(checkSilence, 1000);
  }

  window.plisto.ready.then(start);
})();
