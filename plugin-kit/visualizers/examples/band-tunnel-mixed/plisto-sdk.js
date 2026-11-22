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
  // Above the host's 10 s wait for a native plugin's answer, so the host's timeout arrives first.
  var RELAY_TIMEOUT_MS = 12000;
  var RELAY_PREFIX = "plugin.";
  var TOPIC_RE = /^[a-z0-9_.-]{1,64}$/;

  /**
   * An API failure: `code` is one of the twelve stable codes, `retryAfterMs` is set for rate_limited, `reason`
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
  // Native page event listeners by topic. No prototype, so a topic such as "__proto__" is a plain key.
  var pluginEvents = Object.create(null);
  // App event listeners by topic, kept apart from the native page events above.
  var appEvents = Object.create(null);
  var own = Object.prototype.hasOwnProperty;
  var resolveReady = null;

  var plisto = {
    sdkVersion: "1.6.0",
    info: null,
    pageOpen: false,
    route: null,
    PlistoError: PlistoError,
  };

  plisto.ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  var SCROLLBAR_STYLE_ID = "plisto-sdk-scrollbars";
  // Zero-specificity selectors and a first-in-head position, so any rule the page writes wins. The thumb is
  // transparent until the pointer is over the scrolling element, as in Plisto's own scroll areas.
  var SCROLLBAR_CSS =
    ":where(:root){--plisto-scroll-thumb:rgba(28,26,64,0.2);--plisto-scroll-thumb-hover:rgba(28,26,64,0.38)}\n" +
    ':where(:root[data-theme="dark"]){--plisto-scroll-thumb:rgba(255,255,255,0.16);--plisto-scroll-thumb-hover:rgba(255,255,255,0.3)}\n' +
    "::-webkit-scrollbar{width:8px;height:8px;background:transparent}\n" +
    "::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}\n" +
    "::-webkit-scrollbar-button{display:none}\n" +
    "::-webkit-scrollbar-thumb{background:transparent;border-radius:999px}\n" +
    ":where(:hover)::-webkit-scrollbar-thumb{background:var(--plisto-scroll-thumb)}\n" +
    "::-webkit-scrollbar-thumb:hover{background:var(--plisto-scroll-thumb-hover)}\n";

  // Never throws: a page with an odd DOM just keeps the system scrollbar.
  function injectScrollbarStyle() {
    try {
      if (document.getElementById(SCROLLBAR_STYLE_ID)) return;
      var host = document.head || document.documentElement;
      var style = document.createElement("style");
      style.id = SCROLLBAR_STYLE_ID;
      style.textContent = SCROLLBAR_CSS;
      host.insertBefore(style, host.firstChild);
    } catch (e) {
      // Styling is cosmetic; the SDK starts regardless.
    }
  }
  injectScrollbarStyle();

  function post(msg, transfer) {
    msg.plisto = PROTOCOL;
    if (transfer) window.parent.postMessage(msg, "*", transfer);
    else window.parent.postMessage(msg, "*");
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
      case "plisto:stream":
        onStream(data);
        break;
      case "plisto:socket":
        onSocket(data);
        break;
      case "plisto:plugin-event":
        onPluginEvent(data);
        break;
      case "plisto:event":
        onAppEvent(data);
        break;
      case "plisto:channel":
        onChannel(data);
        break;
      default:
        // Unknown types belong to later protocol additions and are ignored.
        break;
    }
  });

  // Sends one call. `body` is an ArrayBuffer moved to the host with the call; only net.fetch takes one.
  function request(method, args, options, body) {
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
      var msg = { type: "plisto:call", id: id, method: method, args: text };
      if (body) {
        msg.body = body;
        post(msg, [body]);
      } else {
        post(msg);
      }
    });
  }

  /** Calls a host method. Resolves with the method's result; rejects with PlistoError. */
  plisto.call = function (method, args, options) {
    return request(method, args, options, null);
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

  // Calls the listeners of `topic` in `table`, if any.
  function deliver(table, topic, value) {
    if (typeof topic !== "string" || !own.call(table, topic)) return;
    var list = table[topic].slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](value);
      } catch (e) {
        // A throwing subscriber must not stop the others or the message loop.
      }
    }
  }

  function onPluginEvent(data) {
    deliver(pluginEvents, data.topic, data.data);
  }

  // The topic `stream` never travels on this channel: it has its own, read through onPluginEvent.
  function onAppEvent(data) {
    if (data.topic === "stream") return;
    deliver(appEvents, data.topic, data.data);
  }

  /**
   * Subscribes to the page events this plugin's native program sends with `topic` (1 to 64 characters of
   * a-z, 0-9, "_", "." and "-"). The callback gets the event's data. Returns an unsubscribe function.
   */
  plisto.onPluginEvent = function (topic, callback) {
    if (typeof topic !== "string" || !TOPIC_RE.test(topic) || typeof callback !== "function") {
      throw new TypeError("plisto.onPluginEvent: bad topic or callback");
    }
    if (!own.call(pluginEvents, topic)) pluginEvents[topic] = [];
    pluginEvents[topic].push(callback);
    return function () {
      var list = pluginEvents[topic];
      var i = list ? list.indexOf(callback) : -1;
      if (i >= 0) list.splice(i, 1);
    };
  };

  plisto.events = {
    /**
     * Replaces this page's set of app event topics with `topics` (an empty array clears it). Resolves
     * `{ topics, current }`: the accepted topics, and the current value of each state topic that could
     * be read. The values in `current` reach the handlers of `events.on` before the promise resolves.
     */
    subscribe: function (topics) {
      return plisto.call("events.subscribe", { topics: topics }).then(function (result) {
        var current = result && typeof result.current === "object" ? result.current : null;
        if (current) {
          var names = Object.keys(current);
          for (var i = 0; i < names.length; i++) deliver(appEvents, names[i], current[names[i]]);
        }
        return result;
      });
    },
    /**
     * Calls `callback` with the data of each `topic` event this page is subscribed to. Returns an
     * unsubscribe function. Does not subscribe: call `subscribe` too.
     */
    on: function (topic, callback) {
      var bad = typeof topic !== "string" || !TOPIC_RE.test(topic) || topic === "stream";
      if (bad || typeof callback !== "function") {
        throw new TypeError("plisto.events.on: bad topic or callback");
      }
      if (!own.call(appEvents, topic)) appEvents[topic] = [];
      appEvents[topic].push(callback);
      return function () {
        var list = appEvents[topic];
        var i = list ? list.indexOf(callback) : -1;
        if (i >= 0) list.splice(i, 1);
      };
    },
    /** The topic names this Plisto offers; empty when it offers none. */
    topics: function () {
      return plisto.call("app.methods", {}).then(function (r) {
        return r && Array.isArray(r.topics) ? r.topics.slice() : [];
      });
    },
  };

  plisto.plugin = {
    /**
     * Calls `name` on this plugin's own native program, which answers it as a `call`. Resolves with its
     * result; rejects with PlistoError, `plugin_error` when the program answered with an error.
     */
    call: function (name, args, options) {
      if (typeof name !== "string") {
        return Promise.reject(new PlistoError("invalid_args", "The method name must be a string."));
      }
      var timeout = { timeoutMs: RELAY_TIMEOUT_MS };
      if (options && options.timeoutMs !== undefined) timeout.timeoutMs = options.timeoutMs;
      return request(RELAY_PREFIX + name, args, timeout, null);
    },
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
    /** A page of a playlist's tracks in play order, album entries expanded; options { cursor, limit }. */
    playlistTracks: function (id, options) {
      return plisto.call("library.playlist_tracks", pageArgs({ id: id }, options));
    },
    /** A page of a playlist's entries, tracks and albums, in playlist order; options { cursor, limit }. */
    playlistEntries: function (id, options) {
      return plisto.call("library.playlist_entries", pageArgs({ id: id }, options));
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

  // ---- net: pure helpers ----

  var STREAM_WINDOW = 1048576;
  var ACK_BYTES = 262144;
  var ACK_DELAY_MS = 250;
  var FETCH_DEFAULT_TIMEOUT_MS = 30000;
  var SOCKET_DEFAULT_TIMEOUT_MS = 15000;
  // The call waits this much longer than the host's own deadline, so the host answers first.
  var CALL_MARGIN_MS = 5000;
  var SSE_DEFAULT_RETRY_MS = 3000;
  var SSE_MIN_RETRY_MS = 1000;
  var ORPHAN_IDS_MAX = 16;
  // Errors a retry can get past.
  var RETRYABLE = { network: true, timeout: true, busy: true, rate_limited: true };
  var CLOSED_IDS_MAX = 64;
  // Largest line or event the event-stream parser holds, and the most a socket holds for a page that has
  // not set its handlers.
  var SSE_MAX_CHARS = 1048576;
  var SOCKET_HELD_MAX = 100;
  var SOCKET_HELD_BYTES = 4194304;

  function noop() {}

  function isArrayBuffer(v) {
    return Object.prototype.toString.call(v) === "[object ArrayBuffer]";
  }

  function asPlistoError(e) {
    return e instanceof PlistoError ? e : new PlistoError("invalid_args", e && e.message ? e.message : undefined);
  }

  /** Base64 of a Uint8Array, built in slices so a large array does not overflow the argument limit. */
  function toBase64(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  /** One Uint8Array holding `chunks` (Uint8Arrays totalling `total` bytes), in order. */
  function concatChunks(chunks, total) {
    var out = new Uint8Array(total);
    var at = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], at);
      at += chunks[i].byteLength;
    }
    return out;
  }

  /** Reads a ReadableStream of Uint8Array to its end and resolves the bytes as one Uint8Array. */
  function readAll(stream) {
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function step() {
      return reader.read().then(function (r) {
        if (r.done) return concatChunks(chunks, total);
        chunks.push(r.value);
        total += r.value.byteLength;
        return step();
      });
    }
    return step();
  }

  /**
   * Parses text/event-stream to the WHATWG HTML rules (data, event, id and retry fields, comments, CR, LF
   * and CRLF line ends, a leading byte order mark). Feed decoded text to push() in any slicing. Handlers:
   * onEvent({ type, data, lastEventId }), onRetry(ms), onId(id), onOverflow(). A line or an event over
   * SSE_MAX_CHARS calls onOverflow once and the parser then ignores all input. An event the stream ends in
   * the middle of is never dispatched.
   */
  function createEventParser(handlers, lastEventId) {
    var buffer = "";
    var skipLf = false;
    var atStart = true;
    var data = "";
    var type = "";
    var lastId = lastEventId || "";
    var dead = false;

    function overflow() {
      dead = true;
      buffer = "";
      data = "";
      if (handlers.onOverflow) handlers.onOverflow();
    }

    function dispatch() {
      if (data === "") {
        type = "";
        return;
      }
      var event = { type: type === "" ? "message" : type, data: data.slice(0, -1), lastEventId: lastId };
      data = "";
      type = "";
      handlers.onEvent(event);
    }

    function line(text) {
      if (text === "") {
        dispatch();
        return;
      }
      if (text.charAt(0) === ":") return;
      var field = text;
      var value = "";
      var colon = text.indexOf(":");
      if (colon >= 0) {
        field = text.slice(0, colon);
        value = text.slice(colon + 1);
        if (value.charAt(0) === " ") value = value.slice(1);
      }
      if (field === "event") {
        type = value;
      } else if (field === "data") {
        data += value + "\n";
        if (data.length > SSE_MAX_CHARS) overflow();
      } else if (field === "id") {
        if (value.indexOf("\u0000") < 0) {
          lastId = value;
          if (handlers.onId) handlers.onId(value);
        }
      } else if (field === "retry") {
        if (/^[0-9]+$/.test(value) && handlers.onRetry) handlers.onRetry(parseInt(value, 10));
      }
    }

    return {
      push: function (text) {
        if (!text || dead) return;
        if (atStart) {
          atStart = false;
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        }
        // A CR ended the last chunk: an LF opening this one belongs to the same line end.
        if (skipLf && text.charAt(0) === "\n") text = text.slice(1);
        skipLf = false;
        buffer += text;
        var start = 0;
        for (var i = 0; i < buffer.length; i++) {
          var c = buffer.charAt(i);
          if (c !== "\n" && c !== "\r") continue;
          line(buffer.slice(start, i));
          if (dead) return;
          if (c === "\r") {
            if (i + 1 < buffer.length) {
              if (buffer.charAt(i + 1) === "\n") i++;
            } else {
              skipLf = true;
            }
          }
          start = i + 1;
        }
        buffer = buffer.slice(start);
        if (buffer.length > SSE_MAX_CHARS) overflow();
      },
    };
  }

  /**
   * Acknowledges a running byte total to the host in batches, for a stream body and a socket alike. `read()`
   * returns the total the page has taken so far. `account()` acknowledges it at once when ACK_BYTES are
   * unacknowledged, else after ACK_DELAY_MS, so a flood of small messages costs few calls. A refused
   * acknowledgement that retrying can fix is sent again, or the host would end the transfer as stalled.
   * `io` supplies ack(total) (may return a promise), setTimer(fn, ms) and clearTimer(handle). `stop()` ends
   * all of it: nothing is sent afterwards.
   */
  function createAcker(io, read) {
    var acked = 0;
    var timer = null;
    var finished = false;

    function sendAck(total) {
      if (timer !== null) {
        io.clearTimer(timer);
        timer = null;
      }
      var previous = acked;
      acked = total;
      var sent = io.ack(total);
      if (sent && typeof sent.then === "function") {
        sent.then(null, function (e) {
          if (finished || acked !== total || !(e && RETRYABLE[e.code] === true)) return;
          acked = previous;
          if (timer === null) {
            var wait = typeof e.retryAfterMs === "number" ? Math.max(ACK_DELAY_MS, e.retryAfterMs) : ACK_DELAY_MS;
            timer = io.setTimer(onTimer, wait);
          }
        });
      }
    }

    function onTimer() {
      timer = null;
      if (finished) return;
      var total = read();
      if (total > acked) sendAck(total);
    }

    return {
      account: function () {
        if (finished) return;
        var total = read();
        if (total - acked >= ACK_BYTES) sendAck(total);
        else if (total > acked && timer === null) timer = io.setTimer(onTimer, ACK_DELAY_MS);
      },
      stop: function () {
        finished = true;
        if (timer !== null) {
          io.clearTimer(timer);
          timer = null;
        }
      },
      acked: function () {
        return acked;
      },
    };
  }

  /**
   * The body of a streamed response. The host's chunks arrive through chunk(seq, bytes), end() and fail(err);
   * the page reads the returned ReadableStream. The stream queues at most STREAM_WINDOW bytes the page has
   * not read; what the page has read is acknowledged so the host keeps sending: at once when ACK_BYTES are
   * unacknowledged, else after ACK_DELAY_MS. A gap in `seq` fails the stream. `io` supplies everything with
   * a side effect: ReadableStream, ack(totalBytes) (may return a promise; a retryable rejection is
   * retried), cancel(), setTimer(fn, ms), clearTimer(handle) and onDone().
   */
  function createStreamBody(io) {
    var expectSeq = 1;
    var received = 0;
    var finished = false;
    var controller = null;

    // Bytes the page has read: everything received minus what still sits in the stream's queue.
    function consumed() {
      var desired = controller.desiredSize;
      return desired === null ? acker.acked() : received - (STREAM_WINDOW - desired);
    }

    var acker = createAcker(io, consumed);
    var account = acker.account;

    function stop() {
      finished = true;
      acker.stop();
      io.onDone();
    }

    var body = new io.ReadableStream(
      {
        start: function (c) {
          controller = c;
        },
        pull: account,
        cancel: function () {
          if (finished) return;
          stop();
          io.cancel();
        },
      },
      {
        highWaterMark: STREAM_WINDOW,
        size: function (chunk) {
          return chunk.byteLength;
        },
      },
    );

    return {
      body: body,
      chunk: function (seq, bytes) {
        if (finished) return;
        if (seq !== expectSeq) {
          stop();
          controller.error(new PlistoError("network", "The stream lost data.", undefined, "protocol"));
          io.cancel();
          return;
        }
        expectSeq++;
        if (bytes.byteLength === 0) return;
        received += bytes.byteLength;
        controller.enqueue(bytes);
        account();
      },
      end: function () {
        if (finished) return;
        stop();
        controller.close();
      },
      fail: function (error) {
        if (finished) return;
        stop();
        controller.error(error);
      },
    };
  }

  /** The bytes of an init body as a fresh ArrayBuffer, or null for no body. Sets a default content-type. */
  function encodeBody(init, headers) {
    var body = init.body;
    var type = null;
    if (init.json !== undefined) {
      if (body !== undefined && body !== null) {
        throw new PlistoError("invalid_args", "Give either body or json, not both.");
      }
      body = JSON.stringify(init.json);
      if (typeof body !== "string") throw new PlistoError("invalid_args", "The json value could not be serialized.");
      type = "application/json";
    }
    if (body === undefined || body === null) return null;
    var bytes;
    if (typeof body === "string") {
      bytes = new TextEncoder().encode(body);
      type = type || "text/plain;charset=UTF-8";
    } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      bytes = new TextEncoder().encode(body.toString());
      type = "application/x-www-form-urlencoded;charset=UTF-8";
    } else if (isArrayBuffer(body)) {
      bytes = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
      bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else {
      throw new PlistoError("invalid_args", "body must be a string, ArrayBuffer, typed array or URLSearchParams.");
    }
    if (type && !headers.has("content-type")) headers.set("content-type", type);
    var out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }

  /** Header init (object, Headers or pairs) as a Headers; names and values the platform refuses are invalid_args. */
  function toHeaders(init) {
    try {
      return new Headers(init);
    } catch (e) {
      throw new PlistoError("invalid_args", "The headers are not valid.");
    }
  }

  /** A Headers as a plain object, or undefined when it holds none. */
  function headersObject(headers) {
    var out = {};
    var any = false;
    headers.forEach(function (value, name) {
      out[name] = value;
      any = true;
    });
    return any ? out : undefined;
  }

  // ---- net: host events ----

  var streams = {};
  var sockets = {};
  // Events that arrive before the call that names their stream or socket has resolved wait here.
  var orphans = {};
  var orphanOrder = [];
  // Ids of streams that ended on the page's side; late host events for them are ignored.
  var closed = {};
  var closedOrder = [];
  var nextAbort = 1;

  function markClosed(id) {
    delete streams[id];
    if (closed[id]) return;
    if (closedOrder.length >= CLOSED_IDS_MAX) delete closed[closedOrder.shift()];
    closed[id] = true;
    closedOrder.push(id);
  }

  function holdOrphan(id, data) {
    if (!orphans[id]) {
      if (orphanOrder.length >= ORPHAN_IDS_MAX) delete orphans[orphanOrder.shift()];
      orphans[id] = [];
      orphanOrder.push(id);
    }
    orphans[id].push(data);
  }

  function takeOrphans(id) {
    var held = orphans[id] || [];
    if (orphans[id]) {
      delete orphans[id];
      orphanOrder.splice(orphanOrder.indexOf(id), 1);
    }
    return held;
  }

  function deliverStream(id, core, data) {
    if (data.kind === "chunk") {
      core.chunk(data.seq, new Uint8Array(isArrayBuffer(data.data) ? data.data : 0));
    } else if (data.kind === "end") {
      delete streams[id];
      core.end();
    } else if (data.kind === "error") {
      delete streams[id];
      core.fail(
        new PlistoError(typeof data.code === "string" ? data.code : "network", undefined, undefined, data.reason),
      );
    }
  }

  function onStream(data) {
    if (typeof data.stream !== "string" || closed[data.stream]) return;
    var core = streams[data.stream];
    if (core) deliverStream(data.stream, core, data);
    else holdOrphan(data.stream, data);
  }

  function onSocket(data) {
    if (typeof data.socket !== "string") return;
    var sock = sockets[data.socket];
    if (sock) sock.deliver(data);
    else holdOrphan(data.socket, data);
  }

  // ---- net: fetch ----

  function callTimeout(timeoutMs, fallback) {
    var own = typeof timeoutMs === "number" && isFinite(timeoutMs) ? timeoutMs : fallback;
    return Math.min(MAX_TIMEOUT_MS, own + CALL_MARGIN_MS);
  }

  function makeResponse(result, buffer, body) {
    var headers = new Headers();
    var pairs = Array.isArray(result.headers) ? result.headers : [];
    for (var i = 0; i < pairs.length; i++) {
      try {
        headers.append(pairs[i][0], pairs[i][1]);
      } catch (e) {
        // A header the platform refuses is left out.
      }
    }
    var used = false;

    function consume() {
      if (used || body.locked) return Promise.reject(new TypeError("The body was already read."));
      used = true;
      return buffer ? Promise.resolve(new Uint8Array(buffer)) : readAll(body);
    }

    var response = {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      url: result.url,
      redirected: result.redirected === true,
      headers: headers,
      setCookies: Array.isArray(result.set_cookies) ? result.set_cookies : [],
      body: body,
      arrayBuffer: function () {
        return consume().then(function (bytes) {
          return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
        });
      },
      bytes: consume,
      text: function () {
        return consume().then(function (bytes) {
          return new TextDecoder("utf-8").decode(bytes);
        });
      },
      json: function () {
        return response.text().then(function (text) {
          return JSON.parse(text);
        });
      },
      blob: function () {
        return consume().then(function (bytes) {
          return new Blob([bytes], { type: headers.get("content-type") || "" });
        });
      },
    };
    Object.defineProperty(response, "bodyUsed", {
      enumerable: true,
      get: function () {
        return used || body.locked;
      },
    });
    return response;
  }

  function closedStream() {
    return new ReadableStream({
      start: function (c) {
        c.close();
      },
    });
  }

  function bufferStream(buffer) {
    return new ReadableStream({
      start: function (c) {
        if (buffer.byteLength > 0) c.enqueue(new Uint8Array(buffer));
        c.close();
      },
    });
  }

  /**
   * Fetches through Plisto. Resolves a PlistoResponse for any HTTP status; rejects with PlistoError when the
   * request could not be made or completed.
   */
  function netFetch(url, init) {
    init = init || {};
    var args;
    var bodyBuffer;
    var signal = init.signal || null;
    try {
      args = { url: String(url) };
      var headers = toHeaders(init.headers);
      bodyBuffer = encodeBody(init, headers);
      var names = headersObject(headers);
      if (names) args.headers = names;
      if (init.method !== undefined) args.method = String(init.method).toUpperCase();
      if (init.redirect !== undefined) args.redirect = init.redirect;
      if (init.timeoutMs !== undefined) args.timeout_ms = init.timeoutMs;
      if (init.stream === true) args.stream = true;
      if (init.idleMs !== undefined) args.idle_ms = init.idleMs;
    } catch (e) {
      return Promise.reject(asPlistoError(e));
    }
    if (signal && signal.aborted) {
      return Promise.reject(new PlistoError("aborted", "The request was aborted.", undefined, "abort"));
    }

    var detach = noop;
    if (signal) {
      var key = "a" + nextAbort++ + "-" + Math.random().toString(36).slice(2, 10);
      args.abort_key = key;
      var onAbort = function () {
        plisto.call("net.abort", { abort_key: key }).catch(noop);
      };
      signal.addEventListener("abort", onAbort);
      detach = function () {
        signal.removeEventListener("abort", onAbort);
      };
    }

    var timeoutMs = callTimeout(init.timeoutMs, FETCH_DEFAULT_TIMEOUT_MS);
    return request("net.fetch", args, { timeoutMs: timeoutMs }, bodyBuffer).then(
      function (result) {
        if (args.stream !== true) {
          detach();
          var buffer = isArrayBuffer(result.body) ? result.body : new ArrayBuffer(0);
          return makeResponse(result, buffer, bufferStream(buffer));
        }
        if (typeof result.stream !== "string") {
          detach();
          return makeResponse(result, null, closedStream());
        }
        var id = result.stream;
        var core = createStreamBody({
          ReadableStream: ReadableStream,
          ack: function (total) {
            return plisto.call("net.stream.ack", { stream: id, bytes: total });
          },
          cancel: function () {
            plisto.call("net.stream.cancel", { stream: id }).catch(noop);
          },
          setTimer: function (fn, ms) {
            return setTimeout(fn, ms);
          },
          clearTimer: function (handle) {
            clearTimeout(handle);
          },
          onDone: function () {
            detach();
            markClosed(id);
          },
        });
        streams[id] = core;
        var held = takeOrphans(id);
        for (var i = 0; i < held.length; i++) {
          if (streams[id]) deliverStream(id, core, held[i]);
        }
        return makeResponse(result, null, core.body);
      },
      function (e) {
        detach();
        throw e;
      },
    );
  }

  // ---- net: images ----

  /** Fetches an image and resolves a blob: URL for an <img> (a data: URL when blob URLs are unavailable). */
  function netImageUrl(url, init) {
    return netFetch(url, Object.assign({}, init, { stream: false })).then(function (res) {
      var type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!res.ok || type.indexOf("image/") !== 0) {
        var error = new Error(res.ok ? "The response is not an image." : "The server answered " + res.status + ".");
        error.status = res.status;
        throw error;
      }
      return res.bytes().then(function (bytes) {
        try {
          return URL.createObjectURL(new Blob([bytes], { type: type }));
        } catch (e) {
          return "data:" + type + ";base64," + toBase64(bytes);
        }
      });
    });
  }

  function netRevoke(url) {
    if (typeof url !== "string" || url.indexOf("blob:") !== 0) return;
    try {
      URL.revokeObjectURL(url);
    } catch (e) {
      // Nothing to release.
    }
  }

  // ---- net: server-sent events ----

  /**
   * Server-Sent Events over a streamed fetch. options: { headers, lastEventId, timeoutMs, idleMs }. Events
   * go to onmessage (type "message") and to listeners added for their own type. The source reconnects after
   * the server's `retry` (default 3 s, at least 1 s), sending last-event-id, until close(), a 204, a
   * non-200 answer, a reply that is not text/event-stream, or an error that retrying cannot fix.
   */
  function netEventSource(url, options) {
    options = options || {};
    var target = String(url);
    var retryMs = SSE_DEFAULT_RETRY_MS;
    var lastId = typeof options.lastEventId === "string" ? options.lastEventId : "";
    var listeners = Object.create(null);
    var reconnectTimer = null;
    var controller = typeof AbortController === "function" ? new AbortController() : null;

    var source = {
      url: target,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      addEventListener: function (type, callback) {
        if (typeof callback !== "function") return;
        var list = listeners[type] || (listeners[type] = []);
        if (list.indexOf(callback) < 0) list.push(callback);
      },
      removeEventListener: function (type, callback) {
        var list = listeners[type];
        if (!list) return;
        var i = list.indexOf(callback);
        if (i >= 0) list.splice(i, 1);
      },
      close: function () {
        source.readyState = 2;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        if (controller) controller.abort();
      },
    };

    // `own` marks Plisto's open and error events; a server event of any name reaches only the listeners for
    // its type, and onmessage when it is a message.
    function fire(event, own) {
      var handler = own || event.type === "message" ? source["on" + event.type] : null;
      var list = (listeners[event.type] || []).slice();
      if (typeof handler === "function") list.unshift(handler);
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].call(source, event);
        } catch (e) {
          // A throwing listener must not stop the others or the stream.
        }
      }
    }

    function fail(error, canRetry) {
      if (source.readyState === 2) return;
      source.readyState = canRetry ? 0 : 2;
      fire({ type: "error", error: error }, true);
      if (!canRetry || source.readyState === 2) return;
      var wait = retryMs;
      if (error && typeof error.retryAfterMs === "number") wait = Math.max(wait, error.retryAfterMs);
      reconnectTimer = setTimeout(connect, wait);
    }

    function connect() {
      reconnectTimer = null;
      if (source.readyState === 2) return;
      var headers;
      try {
        headers = toHeaders(options.headers);
      } catch (e) {
        fail(e, false);
        return;
      }
      headers.set("accept", "text/event-stream");
      headers.set("cache-control", "no-cache");
      if (lastId !== "" && lastId.length <= 4096 && /^[\x20-\x7e]*$/.test(lastId)) {
        headers.set("last-event-id", lastId);
      }
      var init = { headers: headers, stream: true };
      if (options.timeoutMs !== undefined) init.timeoutMs = options.timeoutMs;
      if (options.idleMs !== undefined) init.idleMs = options.idleMs;
      if (controller) init.signal = controller.signal;

      netFetch(target, init)
        .then(function (res) {
          if (source.readyState === 2) {
            res.body.cancel();
            return null;
          }
          var type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          if (res.status !== 200 || type !== "text/event-stream") {
            res.body.cancel();
            fail(null, false);
            return null;
          }
          source.readyState = 1;
          fire({ type: "open" }, true);
          var decoder = new TextDecoder("utf-8", { ignoreBOM: true });
          var parser = createEventParser(
            {
              onEvent: function (event) {
                if (source.readyState === 1) fire(event);
              },
              onId: function (id) {
                lastId = id;
              },
              onRetry: function (ms) {
                retryMs = Math.max(SSE_MIN_RETRY_MS, ms);
              },
              onOverflow: function () {
                fail(new PlistoError("too_large", "An event is over 1 MiB.", undefined, "event"), false);
              },
            },
            lastId,
          );
          var reader = res.body.getReader();
          var step = function () {
            return reader.read().then(function (r) {
              if (r.done) return null;
              parser.push(decoder.decode(r.value, { stream: true }));
              if (source.readyState === 1) return step();
              reader.cancel();
              return null;
            });
          };
          return step().then(function () {
            // The server closed the stream: connect again.
            fail(null, true);
          });
        })
        .catch(function (e) {
          if (source.readyState === 2) return;
          fail(e, e instanceof PlistoError && RETRYABLE[e.code] === true);
        });
    }

    connect();
    return source;
  }

  // ---- net: sockets ----

  /** Opens a socket through Plisto. Resolves a PlistoSocket once the handshake is done. */
  function netSocket(url, options) {
    options = options || {};
    var args = { url: String(url) };
    try {
      if (options.protocols !== undefined) args.protocols = options.protocols;
      if (options.headers !== undefined) args.headers = headersObject(toHeaders(options.headers));
    } catch (e) {
      return Promise.reject(asPlistoError(e));
    }
    if (options.timeoutMs !== undefined) args.timeout_ms = options.timeoutMs;
    var timeoutMs = callTimeout(options.timeoutMs, SOCKET_DEFAULT_TIMEOUT_MS);
    return request("net.socket.open", args, { timeoutMs: timeoutMs }, null).then(function (result) {
      var id = result.socket;
      var queue = [];
      var onmessage = null;
      var onclose = null;
      var socket = {
        id: id,
        protocol: typeof result.protocol === "string" ? result.protocol : null,
        /** Sends a string as a text message, an ArrayBuffer or typed array as a binary one. */
        send: function (data) {
          var sendArgs = { socket: id };
          if (typeof data === "string") {
            sendArgs.text = data;
          } else if (isArrayBuffer(data)) {
            sendArgs.data_b64 = toBase64(new Uint8Array(data));
          } else if (ArrayBuffer.isView(data)) {
            sendArgs.data_b64 = toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          } else {
            return Promise.reject(
              new PlistoError("invalid_args", "A socket sends a string, ArrayBuffer or typed array."),
            );
          }
          return plisto.call("net.socket.send", sendArgs);
        },
        close: function (code, reason) {
          var closeArgs = { socket: id };
          if (code !== undefined) closeArgs.code = code;
          if (reason !== undefined) closeArgs.reason = reason;
          return plisto.call("net.socket.close", closeArgs);
        },
      };

      // Held until the page sets a handler: at most SOCKET_HELD_MAX messages and SOCKET_HELD_BYTES bytes (the
      // oldest are dropped first), and the close, which is never dropped.
      var heldBytes = 0;
      var closeEvent = null;
      function sizeOf(data) {
        return typeof data.data === "string" ? data.data.length : data.data ? data.data.byteLength : 0;
      }
      function call(handler, event) {
        try {
          handler.call(socket, event);
        } catch (e) {
          // A throwing handler must not stop later events.
        }
      }
      // The bytes of messages handed to onmessage or dropped from the held queue, as the host counts them: a
      // text message by its UTF-8 length, a binary one by its byteLength. The host pauses reading until this
      // total is acknowledged, so a held message is not counted until it leaves the queue.
      var taken = 0;
      var acker = createAcker(
        {
          ack: function (total) {
            return plisto.call("net.socket.ack", { socket: id, bytes: total });
          },
          setTimer: function (fn, ms) {
            return setTimeout(fn, ms);
          },
          clearTimer: function (handle) {
            clearTimeout(handle);
          },
        },
        function () {
          return taken;
        },
      );
      function wireSize(data) {
        return typeof data.data === "string" ? new TextEncoder().encode(data.data).length : sizeOf(data);
      }
      function drain() {
        if (typeof onmessage === "function") {
          while (queue.length > 0) {
            var data = queue.shift();
            heldBytes -= sizeOf(data);
            taken += wireSize(data);
            call(onmessage, { data: data.data });
          }
        }
        acker.account();
        // The close is final: messages still held have no handler and are dropped with it.
        if (closeEvent && typeof onclose === "function") {
          var close = closeEvent;
          closeEvent = null;
          queue.length = 0;
          heldBytes = 0;
          call(onclose, { code: close.code, reason: close.reason || "", wasClean: close.clean === true });
        }
      }
      Object.defineProperty(socket, "onmessage", {
        enumerable: true,
        get: function () {
          return onmessage;
        },
        set: function (fn) {
          onmessage = fn;
          drain();
        },
      });
      Object.defineProperty(socket, "onclose", {
        enumerable: true,
        get: function () {
          return onclose;
        },
        set: function (fn) {
          onclose = fn;
          drain();
        },
      });

      var entry = {
        deliver: function (data) {
          if (data.kind === "close") {
            delete sockets[id];
            closeEvent = data;
            // The socket is gone: an acknowledgement now would be refused.
            acker.stop();
          } else {
            queue.push(data);
            heldBytes += sizeOf(data);
            while (queue.length > SOCKET_HELD_MAX || heldBytes > SOCKET_HELD_BYTES) {
              var dropped = queue.shift();
              heldBytes -= sizeOf(dropped);
              taken += wireSize(dropped);
            }
          }
          drain();
        },
      };
      sockets[id] = entry;
      var held = takeOrphans(id);
      for (var i = 0; i < held.length; i++) entry.deliver(held[i]);
      return socket;
    });
  }

  plisto.net = {
    fetch: netFetch,
    eventSource: netEventSource,
    imageUrl: netImageUrl,
    revoke: netRevoke,
    socket: netSocket,
    // Pure helpers, reachable for the kit's tests. Not part of the API.
    internals: {
      createEventParser: createEventParser,
      createStreamBody: createStreamBody,
      readAll: readAll,
      openStreams: function () {
        return Object.keys(streams).length;
      },
      toBase64: toBase64,
    },
  };

  // ---- stream ----

  var STREAM_PUSH_MAX = 65536;
  // With less room than this, a slice goes out whole: the host's refusal is what arms the room event.
  var STREAM_MIN_SLICE = 4096;
  // A push that waits for room tries again after this long, in case the room event went to another frame.
  var ROOM_RETRY_MS = 2000;

  function itemCall(method) {
    return function (item) {
      return plisto.call(method, { item: item });
    };
  }

  /** The bytes of an ArrayBuffer or a typed array as a Uint8Array over the same memory; null for anything else. */
  function asBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (isArrayBuffer(data)) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function streamPush(item, data) {
    var bytes = asBytes(data);
    if (bytes === null) {
      return Promise.reject(new PlistoError("invalid_args", "The data must be an ArrayBuffer or a typed array."));
    }
    return plisto.call("stream.push", { item: item, data_b64: toBase64(bytes) });
  }

  /**
   * Writes a ReadableStream of Uint8Array into a push item. Each chunk goes out in slices of at most 64 KiB.
   * A `busy` answer waits for the item's `room` event (or ROOM_RETRY_MS) and tries again; a `rate_limited`
   * answer waits its `retryAfterMs`. Resolves `{ bytes }` once the stream is read to its end and, unless
   * `options.end` is false, `stream.end` was called. Rejects with the call's own error, and with `not_found`
   * when the item ends first; the stream is cancelled then.
   */
  function streamPushFrom(item, readable, options) {
    if (!readable || typeof readable.getReader !== "function") {
      return Promise.reject(new PlistoError("invalid_args", "pushFrom needs a ReadableStream."));
    }
    var closeWhenDone = !options || options.end !== false;
    var reader = readable.getReader();
    var room = null;
    var ended = null;
    var wake = null;
    var total = 0;

    var off = plisto.onPluginEvent("stream", function (event) {
      if (!event || event.item !== item) return;
      if (event.kind === "room" && typeof event.room === "number") {
        room = event.room;
      } else if (event.kind === "ended") {
        ended = new PlistoError("not_found", "The item ended (" + event.reason + ").");
        // A read still waiting for the source finishes at once.
        reader.cancel().then(noop, noop);
      } else {
        return;
      }
      if (wake) wake();
    });

    function pause(ms) {
      return new Promise(function (resolve) {
        var timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }

    function writeFrom(bytes, at) {
      if (ended) return Promise.reject(ended);
      if (at >= bytes.length) return Promise.resolve();
      var take = Math.min(STREAM_PUSH_MAX, bytes.length - at);
      if (room !== null && room >= STREAM_MIN_SLICE) take = Math.min(take, room);
      return streamPush(item, bytes.subarray(at, at + take)).then(
        function (result) {
          total += take;
          room = result && typeof result.room === "number" ? result.room : null;
          return writeFrom(bytes, at + take);
        },
        function (e) {
          if (e && e.code === "busy") {
            room = 0;
            return pause(ROOM_RETRY_MS).then(function () {
              return writeFrom(bytes, at);
            });
          }
          if (e && e.code === "rate_limited") {
            return pause(e.retryAfterMs || 100).then(function () {
              return writeFrom(bytes, at);
            });
          }
          throw e;
        },
      );
    }

    function pump() {
      return reader.read().then(function (r) {
        if (ended) throw ended;
        if (r.done) return null;
        var bytes = asBytes(r.value);
        if (bytes === null) {
          throw new PlistoError("invalid_args", "The stream must hold Uint8Array chunks.");
        }
        return writeFrom(bytes, 0).then(pump);
      });
    }

    return pump()
      .then(function () {
        return closeWhenDone ? plisto.stream.end(item) : null;
      })
      .then(
        function () {
          off();
          return { bytes: total };
        },
        function (e) {
          off();
          reader.cancel().then(noop, noop);
          throw e;
        },
      );
  }

  plisto.stream = {
    play: function (args) {
      return plisto.call("stream.play", args);
    },
    update: function (item, fields) {
      return plisto.call("stream.update", Object.assign({}, fields, { item: item }));
    },
    push: streamPush,
    pushFrom: streamPushFrom,
    end: itemCall("stream.end"),
    pause: itemCall("stream.pause"),
    resume: itemCall("stream.resume"),
    stop: itemCall("stream.stop"),
    state: noArgs("stream.state"),
  };

  /** Subscribes to the events of this plugin's stream. Returns an unsubscribe function. */
  plisto.onStream = function (callback) {
    if (typeof callback !== "function") throw new TypeError("plisto.onStream: bad callback");
    return plisto.onPluginEvent("stream", callback);
  };

  // ---- visualizer channel ----

  var CHANNEL_MAX_BYTES = 16384;
  var channelListeners = [];

  // The JSON text of a message; throws a TypeError when it cannot be serialized, a RangeError when too big.
  function channelText(data) {
    var text;
    try {
      text = JSON.stringify(data);
    } catch (e) {
      text = undefined;
    }
    if (typeof text !== "string") throw new TypeError("channel data must be JSON-serializable");
    if (new TextEncoder().encode(text).length > CHANNEL_MAX_BYTES) {
      throw new RangeError("channel data is over " + CHANNEL_MAX_BYTES + " bytes");
    }
    return text;
  }

  function onChannel(data) {
    var from = data.from && typeof data.from.kind === "string" ? { kind: data.from.kind } : { kind: "" };
    var list = channelListeners.slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](data.data, from);
      } catch (e) {
        // A throwing subscriber must not stop the others or the message loop.
      }
    }
  }

  /**
   * The channel to this plugin's live visualizer frames. A message nobody receives is dropped, with no
   * error: at most 16384 bytes of JSON and 20 a second per sending frame.
   */
  plisto.visualizers = {
    send: function (data, kindId) {
      channelText(data);
      if (kindId !== undefined && typeof kindId !== "string") throw new TypeError("kindId must be a string");
      var args = kindId === undefined ? { data: data } : { data: data, kind: kindId };
      request("channel.send", args, null, null).then(noop, noop);
    },
    onMessage: function (callback) {
      if (typeof callback !== "function") throw new TypeError("plisto.visualizers.onMessage: bad callback");
      channelListeners.push(callback);
      return function () {
        var i = channelListeners.indexOf(callback);
        if (i >= 0) channelListeners.splice(i, 1);
      };
    },
  };

  window.plisto = plisto;
})();
