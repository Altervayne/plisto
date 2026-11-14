/*
 * Plisto plugin SDK, protocol 1: the page-side half of the postMessage bridge between a sandboxed plugin
 * page and Plisto. A classic script (an opaque-origin page cannot load a module script), vendored into the
 * plugin folder and loaded from <head> before the page's own script. It defines window.plisto and
 * registers its message listener at once, so heartbeat pings are answered from the first moment.
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var DEFAULT_TIMEOUT_MS = 10000;
  var MAX_TIMEOUT_MS = 600000;
  // Above the host's own deadlines (60 s for a toast, 300 s for a prompt), so the host answers first.
  var TOAST_TIMEOUT_MS = 70000;
  var CONFIRM_TIMEOUT_MS = 310000;

  /**
   * An API failure: `code` is one of the nine stable codes, `retryAfterMs` is set for rate_limited, `reason`
   * refines a code when the host gives one (denied + "no_gesture").
   */
  function PlistoError(code, message, retryAfterMs, reason) {
    var self = new Error(message || code);
    Object.setPrototypeOf(self, PlistoError.prototype);
    self.name = "PlistoError";
    self.code = code;
    self.retryAfterMs = typeof retryAfterMs === "number" ? retryAfterMs : null;
    self.reason = typeof reason === "string" ? reason : null;
    return self;
  }
  PlistoError.prototype = Object.create(Error.prototype, {
    constructor: { value: PlistoError, writable: true, configurable: true },
  });

  var nextId = 1;
  var pending = {};
  var methodSet = null;
  var listeners = { visibility: [], theme: [], sidebar: [], route: [] };
  var resolveReady = null;

  var plisto = {
    sdkVersion: "1.2.0",
    info: null,
    pageOpen: false,
    route: null,
    PlistoError: PlistoError,
  };

  plisto.ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  function post(msg) {
    msg.plisto = PROTOCOL;
    window.parent.postMessage(msg, "*");
  }

  function emit(event, value) {
    var list = listeners[event].slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](value);
      } catch (e) {
        // A throwing subscriber must not stop the others or the message loop.
      }
    }
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  }

  function settle(id) {
    var entry = pending[id];
    if (!entry) return null;
    delete pending[id];
    clearTimeout(entry.timer);
    return entry;
  }

  function onInit(data) {
    var info = data.info && typeof data.info === "object" ? data.info : {};
    plisto.info = info;
    methodSet = {};
    var methods = Array.isArray(data.methods) ? data.methods : [];
    for (var i = 0; i < methods.length; i++) {
      if (typeof methods[i] === "string") methodSet[methods[i]] = true;
    }
    plisto.pageOpen = data.page_open === true;
    plisto.route = typeof data.route === "string" ? data.route : null;
    applyTheme(info.theme);
    if (typeof info.locale === "string") document.documentElement.lang = info.locale;
    resolveReady(info);
  }

  function onResult(data) {
    var entry = settle(data.id);
    if (!entry) return;
    if (data.ok === true) {
      entry.resolve(data.result);
      return;
    }
    var err = data.error && typeof data.error === "object" ? data.error : {};
    entry.reject(
      new PlistoError(
        typeof err.code === "string" ? err.code : "unavailable",
        typeof err.message === "string" ? err.message : undefined,
        err.retry_after_ms,
        err.reason,
      ),
    );
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.plisto !== PROTOCOL) return;
    switch (data.type) {
      case "plisto:ping":
        // Answered straight from the listener so the heartbeat never waits on page code.
        post({ type: "plisto:pong", seq: data.seq });
        break;
      case "plisto:init":
        onInit(data);
        break;
      case "plisto:result":
        onResult(data);
        break;
      case "plisto:visibility":
        plisto.pageOpen = data.page_open === true;
        emit("visibility", plisto.pageOpen);
        break;
      case "plisto:theme":
        applyTheme(data.theme);
        if (plisto.info) plisto.info.theme = data.theme;
        emit("theme", data.theme);
        break;
      case "plisto:sidebar":
        if (typeof data.item_id === "string" && typeof data.gesture === "string") {
          emit("sidebar", {
            item_id: data.item_id,
            value: typeof data.value === "boolean" ? data.value : null,
            gesture: data.gesture,
          });
        }
        break;
      case "plisto:route":
        plisto.route = typeof data.route === "string" ? data.route : null;
        emit("route", plisto.route);
        break;
      default:
        // Unknown types belong to later protocol additions and are ignored.
        break;
    }
  });

  /** Calls a host method. Resolves with the method's result; rejects with PlistoError. */
  plisto.call = function (method, args, options) {
    return new Promise(function (resolve, reject) {
      var text;
      try {
        text = JSON.stringify(args === undefined || args === null ? {} : args);
      } catch (e) {
        reject(new PlistoError("invalid_args", "The arguments could not be serialized."));
        return;
      }
      if (typeof text !== "string") {
        reject(new PlistoError("invalid_args", "The arguments could not be serialized."));
        return;
      }
      var timeoutMs = DEFAULT_TIMEOUT_MS;
      if (options && typeof options.timeoutMs === "number" && isFinite(options.timeoutMs)) {
        timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMs)));
      }
      var id = nextId++;
      var timer = setTimeout(function () {
        // A late result for this id finds no entry and is dropped.
        delete pending[id];
        reject(new PlistoError("timeout", "The call timed out."));
      }, timeoutMs);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      post({ type: "plisto:call", id: id, method: method, args: text });
    });
  };

  /** True when the host listed `method` at init; false before init. */
  plisto.has = function (method) {
    return methodSet !== null && methodSet[method] === true;
  };

  /**
   * Subscribes to "visibility", "theme", "sidebar" (a click on one of the plugin's toggle or action items)
   * or "route" (the page's route changed). Returns an unsubscribe function.
   */
  plisto.on = function (event, callback) {
    if (!listeners.hasOwnProperty(event) || typeof callback !== "function") {
      throw new TypeError("plisto.on: unknown event or callback");
    }
    listeners[event].push(callback);
    return function () {
      var i = listeners[event].indexOf(callback);
      if (i >= 0) listeners[event].splice(i, 1);
    };
  };

  plisto.app = {
    info: function () {
      return plisto.call("app.info", {});
    },
    methods: function () {
      return plisto.call("app.methods", {});
    },
  };

  plisto.storage = {
    get: function (key, fallback) {
      return plisto.call("storage.get", { key: key }).then(function (r) {
        return r.found ? r.value : fallback;
      });
    },
    set: function (key, value) {
      return plisto.call("storage.set", { key: key, value: value });
    },
    remove: function (key) {
      return plisto.call("storage.remove", { key: key });
    },
    keys: function (prefix) {
      return plisto.call("storage.keys", prefix === undefined ? {} : { prefix: prefix });
    },
    clear: function () {
      return plisto.call("storage.clear", {});
    },
    usage: function () {
      return plisto.call("storage.usage", {});
    },
  };

  plisto.ui = {
    /** Shows a toast. Resolves when it leaves: { result: "dismissed" } or { result: "action", gesture }. */
    toast: function (text, options) {
      var args = { text: text };
      if (options && options.action !== undefined) args.action = options.action;
      return plisto.call("ui.toast", args, { timeoutMs: TOAST_TIMEOUT_MS });
    },
    /** Asks the user. Resolves true or false; rejects busy, timeout or denied (reason "no_gesture"). */
    confirm: function (args) {
      return plisto.call("ui.confirm", args, { timeoutMs: CONFIRM_TIMEOUT_MS }).then(function (r) {
        return r.answer === true;
      });
    },
    /** Sets the plugin's sidebar chips; an empty array clears them. */
    chips: function (chips) {
      return plisto.call("ui.chips", { chips: chips });
    },
    /** Opens the plugin's own page, at `route` when given. Gated like a prompt. */
    openPage: function (route, gesture) {
      var args = {};
      if (route !== undefined) args.route = route;
      if (gesture !== undefined) args.gesture = gesture;
      return plisto.call("ui.open_page", args);
    },
    sidebar: {
      /** Replaces the live state of one declared sidebar item. */
      update: function (itemId, state) {
        return plisto.call("ui.sidebar.update", { item_id: itemId, state: state });
      },
    },
  };

  // Copies the page options a list method takes, leaving out the ones not given.
  function pageArgs(base, options) {
    var args = base || {};
    if (options) {
      if (options.sort !== undefined) args.sort = options.sort;
      if (options.cursor !== undefined) args.cursor = options.cursor;
      if (options.limit !== undefined) args.limit = options.limit;
      if (options.kind !== undefined) args.kind = options.kind;
    }
    return args;
  }

  plisto.library = {
    /** A page of tracks; options { sort: "id" | "title" | "artist", cursor, limit }. */
    tracks: function (options) {
      return plisto.call("library.tracks", pageArgs({}, options));
    },
    /** The present tracks among `ids` (at most 200), in that order. Resolves the array. */
    tracksById: function (ids) {
      return plisto.call("library.tracks_by_id", { ids: ids }).then(function (r) {
        return r.items;
      });
    },
    /** A page of albums; options { sort: "id" | "title" | "artist", kind, cursor, limit }. */
    albums: function (options) {
      return plisto.call("library.albums", pageArgs({}, options));
    },
    album: function (id) {
      return plisto.call("library.album", { id: id });
    },
    /** A page of an album's tracks in album order; options { cursor, limit }. */
    albumTracks: function (id, options) {
      return plisto.call("library.album_tracks", pageArgs({ id: id }, options));
    },
    /** A page of playlists; options { sort: "id" | "name", cursor, limit }. */
    playlists: function (options) {
      return plisto.call("library.playlists", pageArgs({}, options));
    },
    playlist: function (id) {
      return plisto.call("library.playlist", { id: id });
    },
    /** A page of a playlist's tracks in playlist order; options { cursor, limit }. */
    playlistTracks: function (id, options) {
      return plisto.call("library.playlist_tracks", pageArgs({ id: id }, options));
    },
    /** Resolves a data: URL for an <img>, or null when there is no cover. */
    cover: function (kind, id, size) {
      return plisto
        .call("library.cover", { kind: kind, id: id, size: size || "thumb" })
        .then(function (r) {
          return r.data_url;
        });
    },
  };

  function noArgs(method) {
    return function () {
      return plisto.call(method, {});
    };
  }

  plisto.playback = {
    state: noArgs("playback.state"),
    queue: noArgs("playback.queue"),
    toggle: noArgs("playback.toggle"),
    pause: noArgs("playback.pause"),
    resume: noArgs("playback.resume"),
    next: noArgs("playback.next"),
    prev: noArgs("playback.prev"),
    seek: function (secs) {
      return plisto.call("playback.seek", { secs: secs });
    },
  };

  // A source is { track_ids }, { album_id } or { playlist_id }.
  plisto.queue = {
    /** Replaces the queue with `source` and plays from `start` (default 0). */
    play: function (source, start) {
      var args = Object.assign({}, source);
      if (start !== undefined) args.start = start;
      return plisto.call("queue.play", args);
    },
    add: function (source) {
      return plisto.call("queue.add", Object.assign({}, source));
    },
    playNext: function (source) {
      return plisto.call("queue.play_next", Object.assign({}, source));
    },
  };

  function logLevel(level) {
    return function (text) {
      return plisto.call("log.write", { level: level, text: String(text) });
    };
  }

  plisto.log = {
    debug: logLevel("debug"),
    info: logLevel("info"),
    warn: logLevel("warn"),
    error: logLevel("error"),
  };

  window.plisto = plisto;
})();
