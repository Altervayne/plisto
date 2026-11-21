/*
 * A static file server for the mock host: serves the plugin-kit folder over http on 127.0.0.1 so a browser
 * can load sdk/mock-host.html and fetch the framed plugin's files and plugin.json. /_plisto/tokens.css and
 * /_plisto/plugin-base.css come from the app's src/styles folder when the kit sits inside the Plisto
 * repository, as Plisto serves them to a plugin page. A plugin folder outside the kit is served under /plugin/.
 * A plugin folder that declares visualizers also gets the visualizer harness at
 * /visualizers/harness/index.html, with its frames on a second origin. With --watch, a change to the plugin
 * folder (and only that folder) tells the harness page to reload.
 * Run: node plugin-kit/sdk/mock-serve.mjs [port] [plugin folder] [--watch]
 */

// -- Library Imports --
import { readFile } from "node:fs/promises";
import { statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, posix, resolve as absolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const kit = fileURLToPath(new URL("..", import.meta.url));
const styles = fileURLToPath(new URL("../../src/styles", import.meta.url));
const args = process.argv.slice(2);
const watching = args.includes("--watch");
const [portArg, pluginArg] = args.filter((a) => !a.startsWith("--"));
const asked = portArg === undefined ? NaN : Number(portArg);
const port = Number.isInteger(asked) && asked >= 0 ? asked : 8765;
const plugin = pluginArg ? absolute(pluginArg) : null;
const WATCH_DEBOUNCE_MS = 150;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const HOST_SHEETS = ["tokens.css", "plugin-base.css"];

// The frame origin for a visualizer plugin; absent for any other plugin, or when the kit has no harness.
const harness = plugin
  ? await import("../visualizers/harness/attach.mjs").then((m) => m.attachHarness(plugin)).catch(() => null)
  : null;

/** `file` when it lies inside `root`, else null. */
function within(root, file) {
  const base = root.endsWith(sep) ? root : root + sep;
  return file.startsWith(base) ? file : null;
}

/** The file a request path names, or null when it would leave its root. */
function resolve(urlPath) {
  const clean = posix.normalize("/" + decodeURIComponent(urlPath.split("?")[0]));
  if (clean.startsWith("/_plisto/")) {
    const sheet = clean.slice("/_plisto/".length);
    return HOST_SHEETS.includes(sheet) ? join(styles, sheet) : null;
  }
  if (plugin && clean.startsWith("/plugin/")) return within(plugin, join(plugin, clean.slice("/plugin".length)));
  return within(kit, join(kit, clean));
}

// -- Watching --

const clients = new Set();

/** Tells every open harness page to reload, once a burst of writes has settled. */
function watchPlugin(dir) {
  let timer = null;
  const hidden = (part) => part.startsWith(".") || part === "node_modules";
  // Reading a folder reports a change on it, so a page load would reload itself; only files count.
  const folder = (name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  };
  const ignored = (name) => !name || String(name).split(/[\\/]/).some(hidden) || folder(String(name));
  const notify = () => {
    timer = null;
    for (const res of clients) res.write("data: reload\n\n");
  };
  try {
    const watcher = watch(dir, { recursive: true }, (_event, name) => {
      if (ignored(name)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(notify, WATCH_DEBOUNCE_MS);
    });
    watcher.on("error", () => watcher.close());
  } catch {
    console.log("--watch could not watch " + dir);
  }
}

function openWatchStream(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.write(": watching\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function send(res, body, type) {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const route = (req.url || "/").split("?")[0];
    if (route === "/_plisto/watch" && watching && plugin) return openWatchStream(req, res);
    if (route === "/_plisto/harness.json" && harness) {
      return send(res, JSON.stringify({ ...harness.config(), watch: watching }), TYPES[".json"]);
    }
    const file = resolve(req.url || "/");
    if (!file) throw new Error("outside");
    send(res, await readFile(file), TYPES[extname(file)] || "application/octet-stream");
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

if (watching && plugin) watchPlugin(plugin);
else if (watching) console.log("--watch needs a plugin folder: mock-serve.mjs [port] <folder> --watch");

server.listen(port, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + server.address().port;
  console.log("Mock host: " + base + "/sdk/mock-host.html?page=../examples/hello-ui/index.html");
  if (harness) console.log("Visualizer harness: " + base + "/visualizers/harness/index.html");
  if (watching && plugin) console.log("Watching " + plugin);
});
