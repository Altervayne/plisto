/*
 * Hello UI page script: a persisted counter, the app info, library calls, the playing track and transport
 * followed through app events, one button per UI surface (toasts, prompts, chips, routes) and three buttons
 * that misbehave on purpose to exercise the host's not-responding overlay, crash handling and navigation
 * guard.
 */
(function () {
  "use strict";

  var KEY = "count";
  var count = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function showCount() {
    $("count").textContent = String(count);
  }

  function row(list, name, value) {
    var dt = document.createElement("dt");
    dt.textContent = name;
    var dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  }

  function showInfo(info) {
    var list = $("info");
    list.textContent = "";
    ["plugin_id", "plugin_version", "plisto_version", "api_version", "locale", "theme", "app_mode", "tier"].forEach(
      function (name) {
        row(list, name, String(info[name]));
      },
    );
    row(list, "granted", (info.granted || []).join(", ") || "(none)");
    row(list, "has(library.tracks)", String(window.plisto.has("library.tracks")));
  }

  function save() {
    return window.plisto.storage.set(KEY, count).catch(function (e) {
      window.plisto.log.warn("save failed: " + e.code);
    });
  }

  // Blocks this page's main thread for the given seconds.
  function busy(seconds) {
    window.plisto.log.info("busy for " + seconds + " s");
    var end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      // Spin.
    }
  }

  $("increment").addEventListener("click", function () {
    count += 1;
    showCount();
    save();
    window.plisto.log.info("count is " + count);
  });
  $("reset").addEventListener("click", function () {
    count = 0;
    showCount();
    save();
    window.plisto.log.info("count reset");
  });
  $("busy8").addEventListener("click", function () {
    busy(8);
  });
  $("busy20").addEventListener("click", function () {
    busy(20);
  });
  $("navigate").addEventListener("click", function () {
    window.location.href = "index.html?x";
  });

  // Adds a line at the top of the results list and keeps the last 14.
  function show(text) {
    var list = $("results");
    var item = document.createElement("li");
    item.textContent = text;
    list.insertBefore(item, list.firstChild);
    while (list.children.length > 14) list.removeChild(list.lastChild);
  }

  function describe(e) {
    var text = e && e.code ? e.code : String(e);
    if (e && e.reason) text += "/" + e.reason;
    if (e && e.retryAfterMs !== null && e.retryAfterMs !== undefined) text += " retry in " + e.retryAfterMs + " ms";
    return text;
  }

  function refused(label) {
    return function (e) {
      show(label + ": refused " + describe(e));
      window.plisto.log.warn(label + " refused: " + describe(e));
    };
  }

  function toast(label, text, options) {
    return window.plisto.ui.toast(text, options).then(function (r) {
      show(label + ": " + r.result);
      return r;
    }, refused(label));
  }

  function ask(label) {
    return window.plisto.ui
      .confirm({
        title: "Do the thing?",
        body: "Hello UI asks for a yes or a no. Plisto shows this prompt and passes back only the answer.",
        confirm_label: "Do it",
      })
      .then(function (answer) {
        show(label + ": answer " + answer);
      }, refused(label));
  }

  function setChips(label, chips) {
    return window.plisto.ui.chips(chips).then(function () {
      show(label + ": set");
    }, refused(label));
  }

  $("toast").addEventListener("click", function () {
    toast("toast", "Hello from Hello UI");
  });
  $("toast-action").addEventListener("click", function () {
    toast("toast action", "Something finished", { action: "Details" }).then(function (r) {
      if (!r || r.result !== "action") return;
      show("gesture arrived (" + r.gesture.length + " characters)");
      window.plisto.ui.openPage("details", r.gesture).then(function () {
        show("open details: sent");
      }, refused("open details"));
    });
  });
  $("toast-flood").addEventListener("click", function () {
    for (var i = 1; i <= 10; i++) toast("flood " + i, "Flood toast " + i);
  });
  $("confirm").addEventListener("click", function () {
    ask("confirm");
  });
  $("confirm-twice").addEventListener("click", function () {
    ask("confirm 1");
    ask("confirm 2");
  });
  $("chips-set").addEventListener("click", function () {
    setChips("chips", [{ text: "3 devices" }, { count: 2, tone: "accent" }]);
  });
  $("chips-long").addEventListener("click", function () {
    setChips("long chip", [{ text: "Reconnecting now", tone: "warn" }]);
  });
  $("chips-clear").addEventListener("click", function () {
    setChips("clear chips", []);
  });
  $("chips-flood").addEventListener("click", function () {
    var failed = false;
    for (var i = 0; i < 30; i++) {
      setTimeout(
        function (n) {
          window.plisto.ui.chips([{ count: n }]).catch(function (e) {
            if (failed) return;
            failed = true;
            show("flood chips " + n + ": first refusal " + describe(e));
          });
        },
        i * 33,
        i,
      );
    }
  });
  function trackLine(track) {
    return (track.title || "(no title)") + " - " + (track.artist || "(no artist)");
  }

  // The first album of the library by title, or null when it has none.
  function firstAlbum() {
    return window.plisto.library.albums({ sort: "title", kind: "album", limit: 1 }).then(function (page) {
      return page.items.length ? page.items[0] : null;
    });
  }

  $("list-tracks").addEventListener("click", function () {
    window.plisto.library.tracks({ sort: "title", limit: 5 }).then(function (page) {
      var list = $("tracks");
      list.textContent = "";
      page.items.forEach(function (track) {
        var item = document.createElement("li");
        item.textContent = trackLine(track);
        list.appendChild(item);
      });
      show("list tracks: " + page.items.length + (page.next_cursor ? ", more follow" : ""));
    }, refused("list tracks"));
  });
  $("grid-cover").addEventListener("click", function () {
    firstAlbum()
      .then(function (album) {
        if (!album) return null;
        return window.plisto.library.cover("album", album.id, "grid");
      })
      .then(function (url) {
        var img = $("cover");
        img.hidden = !url;
        if (url) img.src = url;
        show("grid cover: " + (url ? url.length + " characters" : "none"));
      }, refused("grid cover"));
  });
  $("album-next").addEventListener("click", function () {
    firstAlbum()
      .then(function (album) {
        if (!album) return { queued: 0 };
        return window.plisto.queue.playNext({ album_id: album.id });
      })
      .then(function (r) {
        show("album next: queued " + r.queued);
      }, refused("album next"));
  });
  // ---- Player events ----

  // The latest value of each topic; nothing here reads the player.
  var player = { now: null, state: null };

  function nowText(now) {
    if (!now || now.source === null) return "nothing";
    if (now.source === "file") return "a file outside the library";
    if (now.source === "stream") return now.stream ? now.stream.title + " (stream)" : "a stream";
    return now.track ? trackLine(now.track) : "a track missing on disk";
  }

  // The play head between events: the position at the last event plus the time since, while playing.
  function positionText(state) {
    var secs = state.position_secs;
    if (state.transport === "playing") secs += (Date.now() - state.position_at) / 1000;
    return secs.toFixed(1) + " s";
  }

  function showPlayer() {
    var list = $("player");
    list.textContent = "";
    var state = player.state;
    row(list, "Now playing", nowText(player.now));
    row(list, "Transport", state ? state.transport : "...");
    row(list, "Position", state ? positionText(state) : "...");
    row(list, "Starts, seeks", state ? state.start_seq + ", " + state.seek_seq : "...");
  }

  function followPlayer() {
    var events = window.plisto.events;
    events.on("now_playing", function (data) {
      player.now = data;
      showPlayer();
    });
    events.on("playback_state", function (data) {
      player.state = data;
      showPlayer();
    });
    showPlayer();
    // Only the position row moves between events, and it is worked out here.
    setInterval(showPlayer, 1000);
    events.subscribe(["now_playing", "playback_state"]).then(function (r) {
      show("events: subscribed to " + r.topics.join(", "));
    }, refused("events"));
  }

  $("go-settings").addEventListener("click", function () {
    window.plisto.ui.openPage("settings").then(function () {
      show("open settings: sent");
    }, refused("open settings"));
  });

  function showRoute(route) {
    $("route").textContent = route === null ? "(none)" : route;
  }

  window.plisto.on("route", showRoute);

  window.plisto.ready.then(function (info) {
    showInfo(info);
    showRoute(window.plisto.route);
    if (window.plisto.has("events.subscribe")) followPlayer();
    else show("events: this Plisto does not offer them");
    return window.plisto.storage.get(KEY, 0).then(function (value) {
      count = typeof value === "number" ? value : 0;
      showCount();
    });
  });
})();
