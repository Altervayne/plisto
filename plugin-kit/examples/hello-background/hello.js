/*
 * Hello background page script: counts once a second with a timer (animation frames stop in a hidden
 * frame, timers do not), saves the count every five seconds, and keeps the plugin's sidebar section live:
 * a status line, a progress bar, a toggle and an action. Also logs library changes it hears as app events
 * and runs the gesture tests.
 */
(function () {
  "use strict";

  var KEY = "count";
  var SAVE_EVERY = 5;
  var WARN_EVERY = 20;
  var CONFIRM_DELAY_MS = 500;
  var PROGRESS_MS = 10000;
  var HOLD_MS = 5000;
  var TEST_WAIT_MS = 11000;

  var count = 0;
  var sinceSave = 0;
  var autoOn = false;
  var holdStatusUntil = 0;
  var lastPing = null;
  var phase = "";
  var lastPercent = -1;
  var cycleStart = Date.now();

  function $(id) {
    return document.getElementById(id);
  }

  function showCount() {
    $("count").textContent = String(count);
  }

  function showPageOpen() {
    $("page-open").textContent = String(window.plisto.pageOpen);
  }

  function showTheme() {
    $("theme").textContent = document.documentElement.dataset.theme || "";
  }

  function showRoute(route) {
    $("route").textContent = route === null ? "(none)" : route;
  }

  function showAuto() {
    $("auto").textContent = autoOn ? "on" : "off";
  }

  function describe(e) {
    var text = e && e.code ? e.code : String(e);
    if (e && e.reason) text += "/" + e.reason;
    return text;
  }

  // Logs a refusal, shows it on the page, and holds it on the status line for a few seconds.
  function refused(label, e) {
    var text = describe(e);
    window.plisto.log.warn(label + " refused: " + text);
    $("refusal").textContent = label + ": " + text;
    holdStatusUntil = Date.now() + HOLD_MS;
    update("state", { text: "Refused: " + (e && e.reason ? e.reason : e && e.code), tone: "warn" });
  }

  // A refused update is logged and otherwise ignored; the next tick sends a fresh one.
  function update(itemId, state) {
    return window.plisto.ui.sidebar.update(itemId, state).catch(function (e) {
      window.plisto.log.warn("update " + itemId + " refused: " + describe(e));
    });
  }

  function save() {
    window.plisto.storage
      .set(KEY, count)
      .then(function () {
        $("saved").textContent = String(count);
      })
      .catch(function (e) {
        window.plisto.log.warn("save failed: " + e.code);
      });
    update("home", { chip: { count: count } });
  }

  function showStatus() {
    if (Date.now() < holdStatusUntil) return;
    update("state", { text: "Count " + count, tone: count % WARN_EVERY === 0 ? "warn" : "neutral" });
  }

  function tick() {
    count += 1;
    showCount();
    showStatus();
    sinceSave += 1;
    if (sinceSave >= SAVE_EVERY) {
      sinceSave = 0;
      save();
    }
  }

  // Determinate for the first 10 s of a 20 s cycle, then an indeterminate sweep for 10 s.
  function stepProgress() {
    var elapsed = (Date.now() - cycleStart) % (PROGRESS_MS * 2);
    if (elapsed < PROGRESS_MS) {
      var percent = Math.floor((elapsed / PROGRESS_MS) * 100);
      if (phase === "run" && percent === lastPercent) return;
      phase = "run";
      lastPercent = percent;
      update("work", { value: elapsed / PROGRESS_MS, text: "Working " + percent + "%" });
    } else if (phase !== "wait") {
      phase = "wait";
      update("work", { value: null, text: "Waiting" });
    }
  }

  function pushAuto() {
    update("auto", { on: autoOn, enabled: true });
  }

  function onSidebar(input) {
    if (input.item_id === "auto" && input.value !== null) {
      var wanted = input.value;
      window.plisto.log.info("auto toggle asked for " + wanted);
      if ($("ignore").checked) return;
      setTimeout(function () {
        autoOn = wanted;
        showAuto();
        pushAuto();
      }, CONFIRM_DELAY_MS);
    } else if (input.item_id === "ping") {
      lastPing = { gesture: input.gesture };
      ping(input.gesture);
    }
  }

  function ping(gesture) {
    window.plisto.ui
      .confirm({
        title: "Ping?",
        body: "Hello background asks for a yes or a no. Plisto passes back only your answer.",
        confirm_label: "Ping",
        gesture: gesture,
      })
      .then(
        function (answer) {
          return window.plisto.ui.toast("Ping answered: " + (answer ? "yes" : "no"));
        },
        function (e) {
          refused("ping", e);
        },
      )
      .catch(function (e) {
        window.plisto.log.warn("toast refused: " + describe(e));
      });
  }

  // Waits 11 s, then asks: past the 5 s gesture age and the 10 s confirm refill, so the refusal is no_gesture. Navigating away in between leaves no page and, for the second test, an expired click.
  function delayedAsk(label, gesture) {
    window.plisto.log.info(label + ": asking in " + TEST_WAIT_MS / 1000 + " s");
    setTimeout(function () {
      var args = {
        title: "Test prompt",
        body: "This prompt should have been refused.",
        confirm_label: "OK",
      };
      if (gesture) args.gesture = gesture;
      window.plisto.ui.confirm(args).then(
        function (answer) {
          window.plisto.log.info(label + " was shown, answer " + answer);
        },
        function (e) {
          refused(label, e);
        },
      );
    }, TEST_WAIT_MS);
  }

  // Blocks this page's main thread for 20 seconds.
  $("busy20").addEventListener("click", function () {
    var end = Date.now() + 20000;
    while (Date.now() < end) {
      // Spin.
    }
  });
  $("ask-no-click").addEventListener("click", function () {
    delayedAsk("ask without a click", undefined);
  });
  $("ask-old-click").addEventListener("click", function () {
    delayedAsk("ask with an old click", lastPing ? lastPing.gesture : undefined);
  });

  // Writes a line to the log for each library_changed event. Null ids say "read again", not "this changed".
  function logLibraryChange(change) {
    var what = "all tracks, read again";
    if (change.track_ids !== null) {
      what = change.track_ids.length + " track(s): " + change.track_ids.slice(0, 10).join(", ");
    }
    var scopes = (change.albums ? ", albums" : "") + (change.playlists ? ", playlists" : "");
    window.plisto.log.info("library changed: " + what + scopes);
  }

  // A page starts with no subscription, so every start subscribes again.
  function followLibrary() {
    window.plisto.events.on("library_changed", logLibraryChange);
    window.plisto.events.subscribe(["library_changed"]).then(null, function (e) {
      window.plisto.log.warn("library events refused: " + describe(e));
    });
  }

  window.plisto.on("sidebar", onSidebar);
  window.plisto.on("route", showRoute);

  window.plisto.ready.then(function () {
    showPageOpen();
    showTheme();
    showRoute(window.plisto.route);
    showAuto();
    if (window.plisto.has("events.subscribe")) followLibrary();
    window.plisto.on("visibility", showPageOpen);
    window.plisto.on("theme", showTheme);
    return window.plisto.storage.get(KEY, 0).then(function (value) {
      count = typeof value === "number" ? value : 0;
      showCount();
      $("saved").textContent = String(count);
      pushAuto();
      update("home", { chip: { count: count } });
      showStatus();
      stepProgress();
      setInterval(tick, 1000);
      setInterval(stepProgress, 500);
    });
  });
})();
