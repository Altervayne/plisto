/*
 * Loads a JSON file, a module script and a crossorigin image, and uploads the image to a texture. Each
 * try reports success or the error it met, plus the policy violations the document saw. The page asks
 * for a run over the port and optionally for the second module extension.
 */
(function (root) {
  "use strict";

  var TRY_TIMEOUT_MS = 4000;
  var violations = [];

  document.addEventListener("securitypolicyviolation", function (event) {
    violations.push(event.violatedDirective);
  });

  function describeError(e) {
    return (e && e.name ? e.name : "Error") + ": " + (e && e.message ? e.message : String(e));
  }

  function withTimeout(promise) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        resolve({ ok: false, detail: "no result in " + TRY_TIMEOUT_MS + " ms" });
      }, TRY_TIMEOUT_MS);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (e) {
          clearTimeout(timer);
          resolve({ ok: false, detail: describeError(e) });
        },
      );
    });
  }

  function tryFetch() {
    return fetch("data.json").then(function (response) {
      if (!response.ok) return { ok: false, detail: "status " + response.status };
      return response.json().then(function (body) {
        return { ok: body && body.probe === "data", detail: "status " + response.status };
      });
    });
  }

  function tryModule(file, expected) {
    return new Promise(function (resolve) {
      var script = document.createElement("script");
      script.type = "module";
      script.src = file;
      script.onload = function () {
        resolve({ ok: root.probeModLoaded === expected, detail: "loaded, global " + root.probeModLoaded });
      };
      script.onerror = function () {
        resolve({ ok: false, detail: "script error event" });
      };
      document.head.appendChild(script);
    });
  }

  function loadImage() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error("image error event"));
      };
      img.src = "/gen/pattern.png";
    });
  }

  function tryImage() {
    return loadImage().then(
      function (img) {
        var canvas = document.createElement("canvas");
        var gl = canvas.getContext("webgl2");
        if (!gl) {
          return [
            { ok: true, detail: img.naturalWidth + " px wide" },
            { ok: false, unavailable: true, detail: "no WebGL2 context in the frame" },
          ];
        }
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        var upload;
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          var glError = gl.getError();
          upload = { ok: glError === gl.NO_ERROR, detail: "texImage2D returned, gl error " + glError };
        } catch (e) {
          upload = { ok: false, detail: describeError(e) };
        }
        return [{ ok: true, detail: img.naturalWidth + " px wide" }, upload];
      },
      function (e) {
        return [
          { ok: false, detail: describeError(e) },
          { ok: false, detail: "not attempted" },
        ];
      },
    );
  }

  root.probeReady.then(function (port) {
    port.onmessage = function (event) {
      var data = event.data;
      if (!data || data.type !== "run") return;
      var out = { type: "result" };
      withTimeout(tryFetch())
        .then(function (r) {
          out.fetch = r;
          return withTimeout(tryModule("mod.js", "js"));
        })
        .then(function (r) {
          out.module = r;
          return data.mjs ? withTimeout(tryModule("mod.mjs", "mjs")) : null;
        })
        .then(function (r) {
          if (r) out.mjs = r;
          return withTimeout(tryImage());
        })
        .then(function (r) {
          if (Array.isArray(r)) {
            out.image = r[0];
            out.upload = r[1];
          } else {
            out.image = r;
            out.upload = { ok: false, detail: "not attempted" };
          }
          out.violations = violations.slice();
          port.postMessage(out);
        });
    };
  });
})(globalThis);
