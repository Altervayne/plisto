/*
 * A static file server for the mock host: serves the plugin-kit folder over http on 127.0.0.1 so a browser
 * can load sdk/mock-host.html and fetch the framed plugin's files and plugin.json. /_plisto/tokens.css and
 * /_plisto/plugin-base.css come from the app's src/styles folder when the kit sits inside the Plisto
 * repository, as Plisto serves them to a plugin page. A plugin folder outside the kit is served under /plugin/.
 * Run: node plugin-kit/sdk/mock-serve.mjs [port] [plugin folder]
 */

// -- Library Imports --
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, posix, resolve as absolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const kit = fileURLToPath(new URL("..", import.meta.url));
const styles = fileURLToPath(new URL("../../src/styles", import.meta.url));
const port = Number(process.argv[2]) || 8765;
const plugin = process.argv[3] ? absolute(process.argv[3]) : null;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const HOST_SHEETS = ["tokens.css", "plugin-base.css"];

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

createServer(async (req, res) => {
  try {
    const file = resolve(req.url || "/");
    if (!file) throw new Error("outside");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log("Mock host: http://127.0.0.1:" + port + "/sdk/mock-host.html?page=../examples/hello-ui/index.html");
});
