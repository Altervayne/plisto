/*
 * The checker's static server on 127.0.0.1 at a random port. It serves the plugin folder as the plugin's own
 * origin, Plisto's runtime under the reserved `_plisto` folder the way the app does, and the host page and
 * its job. Plugin files carry the visualizer frame's policy: sandboxed, scripts from the same origin, no
 * network beyond it. Nothing leaves the machine.
 */

// -- Library Imports --
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// -- Local Imports --
import { plainFile } from "./decl.mjs";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST_DIR = "/_plisto/visualizer-lab/";
const RUNTIME_DIR = "/_plisto/vis/1/";

const FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' " +
  "'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src blob:";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
};

// The host page's files and the runtime's, by request path.
const HOST_FILES = {
  "host.html": join(KIT, "lib", "check", "host.html"),
  "host.js": join(KIT, "lib", "check", "host.js"),
  "feed.js": join(KIT, "lib", "check", "feed.js"),
  "protocol.js": join(KIT, "lib", "protocol.js"),
};
const RUNTIME_FILES = {
  "plisto-vis.js": join(KIT, "runtime", "plisto-vis-1.js"),
  "shader.html": join(KIT, "runtime", "shader.html"),
};

/**
 * Starts the server for the plugin folder `dir`. `makeJob(base)` builds the job the host page reads once the
 * port is known. Resolves with its URLs and a `close`.
 */
export function startServer(dir, makeJob) {
  const root = resolve(dir);
  const send = (res, status, body, type, frame) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...(frame && { "content-security-policy": FRAME_CSP }),
    });
    res.end(body);
  };
  const server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      return send(res, 400, "bad request", "text/plain", false);
    }
    const mime = (file) => MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const serve = (res, file, frame) =>
      file
        ? send(res, 200, readFileSync(file), mime(file), frame)
        : send(res, 404, "not found", "text/plain", frame);
    if (path.startsWith(HOST_DIR)) {
      const name = path.slice(HOST_DIR.length);
      if (name === "job.json") {
        const job = makeJob(`http://127.0.0.1:${server.address().port}`);
        return send(res, 200, JSON.stringify(job), MIME[".json"], false);
      }
      return serve(res, HOST_FILES[name], false);
    }
    if (path.startsWith(RUNTIME_DIR)) {
      return serve(res, RUNTIME_FILES[path.slice(RUNTIME_DIR.length)], true);
    }
    const rel = path.replace(/^\/+/, "");
    const full = resolve(root, rel);
    const reserved = rel.split("/").some((p) => p === ".." || p.startsWith("_plisto"));
    const inside = full.startsWith(root + sep) && !reserved;
    if (!inside || !plainFile(root, rel)) return send(res, 404, "not found", "text/plain", true);
    send(res, 200, readFileSync(full), mime(full), true);
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({
        base: `http://127.0.0.1:${port}`,
        hostUrl: `http://127.0.0.1:${port}${HOST_DIR}host.html`,
        close: () => new Promise((done) => (server.closeAllConnections(), server.close(done))),
      });
    });
  });
}

/** The frame URL of a kind: its page, or the runtime's shader page pointed at its shader. */
export function frameUrl(base, decl) {
  return decl.page !== null
    ? `${base}/${decl.page}`
    : `${base}${RUNTIME_DIR}shader.html?shader=${encodeURIComponent(decl.shader)}`;
}
