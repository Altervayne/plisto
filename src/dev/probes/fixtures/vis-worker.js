/*
 * Starts a worker from a blob URL and compiles a WebAssembly module whose bytes are inline, then reports
 * what each did or the error it met, with the policy violations the document saw.
 */
(function (root) {
  "use strict";

  var TRY_TIMEOUT_MS = 3000;
  var violations = [];

  // A module exporting add(i32, i32) -> i32.
  var WASM_ADD = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02,
    0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20,
    0x01, 0x6a, 0x0b,
  ]);

  document.addEventListener("securitypolicyviolation", function (event) {
    violations.push(event.violatedDirective);
  });

  function describeError(e) {
    return (e && e.name ? e.name : "Error") + ": " + (e && e.message ? e.message : String(e));
  }

  function tryWorker() {
    return new Promise(function (resolve) {
      var url;
      var worker;
      var timer = setTimeout(function () {
        if (worker) worker.terminate();
        resolve({ ok: false, detail: "no echo in " + TRY_TIMEOUT_MS + " ms" });
      }, TRY_TIMEOUT_MS);
      function done(result) {
        clearTimeout(timer);
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        resolve(result);
      }
      try {
        var blob = new Blob(["self.onmessage = function (e) { self.postMessage({ echo: e.data + 1 }); };"], {
          type: "text/javascript",
        });
        url = URL.createObjectURL(blob);
        worker = new Worker(url);
      } catch (e) {
        return done({ ok: false, detail: describeError(e) });
      }
      worker.onerror = function (event) {
        done({ ok: false, detail: "worker error event" + (event.message ? ": " + event.message : "") });
      };
      worker.onmessage = function (event) {
        done({ ok: event.data && event.data.echo === 42, detail: "echo " + (event.data && event.data.echo) });
      };
      worker.postMessage(41);
    });
  }

  function tryWasm() {
    try {
      return WebAssembly.instantiate(WASM_ADD).then(
        function (result) {
          var sum = result.instance.exports.add(2, 3);
          return { ok: sum === 5, detail: "add(2, 3) = " + sum };
        },
        function (e) {
          return { ok: false, detail: describeError(e) };
        },
      );
    } catch (e) {
      return Promise.resolve({ ok: false, detail: describeError(e) });
    }
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      if (!event.data || event.data.type !== "run") return;
      tryWorker().then(function (worker) {
        tryWasm().then(function (wasm) {
          port.postMessage({ type: "result", worker: worker, wasm: wasm, violations: violations.slice() });
        });
      });
    };
  });
})(globalThis);
