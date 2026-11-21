// Runs a page in Edge driven over the DevTools protocol and returns the text the page leaves in #out once
// body[data-done] is "1". The clock is real, so timings are true. Every wait ends at the deadline, when Edge
// fails to start, or when the socket closes.
// Edge relaunches itself: the process spawned here exits at once with code 0 and the real browser runs on
// under another parent, holding the profile. A run is therefore tracked by its unique profile folder, found
// in process command lines. Edge is closed through the protocol, and only processes whose command line names
// this profile are ever killed. A profile folder Windows still holds is reported and left, never an error.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXIT_WAIT_MS = 10000;
const START_WAIT_MS = 20000;

const LIST_PIDS =
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:LAB_PROFILE) } | ForEach-Object { $_.ProcessId }";

/**
 * Loads `url` in a fresh headless Edge and resolves with the lab page's #out text.
 * `edge` is the executable, `args` its extra flags, `timeoutMs` the whole-run deadline.
 */
export async function runEdgeLive({ edge, args, url, timeoutMs }) {
  const profile = mkdtempSync(join(tmpdir(), "plisto-lab-"));
  const deadline = Date.now() + timeoutMs;
  let ws = null;
  let browserWs = null;

  /** Pids of the processes whose command line names this run's profile. */
  const profilePids = () => {
    const run =
      process.platform === "win32"
        ? spawnSync("powershell", ["-NoProfile", "-Command", LIST_PIDS], { encoding: "utf8", env: { ...process.env, LAB_PROFILE: profile } })
        : spawnSync("pgrep", ["-f", profile], { encoding: "utf8" });
    return (run.stdout ?? "").split(/\s+/).filter((p) => /^\d+$/.test(p));
  };

  /** Asks Edge to quit, waits for this run's processes to go, and kills any that remain. */
  const shutDown = async () => {
    ws?.close();
    try {
      browserWs?.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    } catch {
      // The socket is already gone; the wait below covers it.
    }
    let left = profilePids();
    for (let waited = 0; left.length > 0 && waited < EXIT_WAIT_MS; waited += 500) {
      await sleep(500);
      left = profilePids();
    }
    for (const pid of left) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
      else process.kill(Number(pid), "SIGKILL");
    }
    browserWs?.close();
  };

  const removeProfile = async () => {
    // Renderer children can outlive the main process for a moment and hold the profile.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(500);
      }
    }
    console.error(`left behind: ${profile} (still held by Edge)`);
  };

  const onInterrupt = async () => {
    await shutDown();
    await removeProfile();
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);

  // Rejects when the browser fails to start, exits, or drops the socket.
  let fail = () => {};
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});

  /** Awaits `promise`, giving up at the deadline or when the browser goes away. */
  const within = (promise, what) => {
    let timer = null;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what} (--timeout ${timeoutMs / 1000} s)`)), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([promise, failed, late]).finally(() => clearTimeout(timer));
  };

  /** Polls `read` until it returns something other than null. */
  const until = async (read, what) => {
    for (;;) {
      const v = await within(read(), what);
      if (v !== null && v !== undefined) return v;
      await within(sleep(500), what);
    }
  };

  const openSocket = async (address, what) => {
    const socket = new WebSocket(address);
    await within(
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve);
        socket.addEventListener("error", () => reject(new Error(`the DevTools socket failed (${what})`)));
      }),
      what,
    );
    return socket;
  };

  try {
    const child = spawn(edge, ["--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=1", "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,800", ...args, url], {
      stdio: "ignore",
    });
    child.on("error", (e) => fail(new Error(`could not start Edge at ${edge}: ${e.message}`)));
    // Exit code 0 is the relaunch hand-off, not a failure.
    child.on("exit", (code) => {
      if (code !== 0) fail(new Error(`Edge exited early (code ${code})`));
    });

    // With port 0 the browser picks one and records it in the profile.
    const portBy = Date.now() + START_WAIT_MS;
    const port = await until(async () => {
      const file = join(profile, "DevToolsActivePort");
      if (existsSync(file)) return readFileSync(file, "utf8").split("\n")[0];
      if (Date.now() > portBy) throw new Error("Edge did not report a DevTools port");
      return null;
    }, "the browser's DevTools port");
    const target = await until(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((t) => t.type === "page" && t.url.includes("visualizer-lab")) ?? null;
      } catch {
        return null;
      }
    }, "the lab page");
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browserWs = await openSocket(version.webSocketDebuggerUrl, "the browser");
    ws = await openSocket(target.webSocketDebuggerUrl, "the lab page");
    ws.addEventListener("close", () => fail(new Error("the DevTools socket closed")));

    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const evaluate = (expression) =>
      within(
        new Promise((resolve) => {
          const n = ++id;
          pending.set(n, resolve);
          ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        }),
        "the page to answer",
      );
    const text = await until(async () => {
      const m = await evaluate("document.body && document.body.dataset.done === '1' ? (document.getElementById('out') || {}).textContent || '' : null");
      return m.result?.result?.value ?? null;
    }, "the lab to finish");
    if (text === "") throw new Error("the lab finished without a result");
    return text;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await shutDown();
    await removeProfile();
  }
}
