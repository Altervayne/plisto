/*
 * The blend test pattern: a grid of flat patches, eight colors at alpha 0, 0.25, 0.5 and 1, drawn with
 * WebGL2 (scissor and premultiplied clear, as the renderer's context is set up) or with Canvas 2D (fillRect).
 * One script serves the frame as a classic script and the page as a side-effect import, so it assigns its
 * API to globalThis. No pattern color is pure magenta: that color marks registration points in screenshots.
 */
(function (root) {
  "use strict";

  // Sized to show whole in one view of the stage slot (about 478 x 268 CSS px): 460 x 236. A patch stays
  // larger than twice the widest edge band the diff clears (8 capture px at DIP scale), so each keeps a
  // compared interior at device and at DIP scale.
  var PATCH_PX = 44;
  var GAP_PX = 12;
  var MARGIN_PX = 12;
  var ALPHAS = [0, 0.25, 0.5, 1];
  var COLORS = [
    [220, 40, 40],
    [40, 180, 60],
    [50, 80, 220],
    [240, 200, 40],
    [40, 200, 210],
    [240, 130, 30],
    [240, 240, 240],
    [40, 40, 48],
  ];

  /** Every patch in CSS pixels from the canvas origin: one column per color, one row per alpha. */
  function patches() {
    var out = [];
    for (var row = 0; row < ALPHAS.length; row++) {
      for (var col = 0; col < COLORS.length; col++) {
        out.push({
          x: MARGIN_PX + col * (PATCH_PX + GAP_PX),
          y: MARGIN_PX + row * (PATCH_PX + GAP_PX),
          w: PATCH_PX,
          h: PATCH_PX,
          color: COLORS[col],
          alpha: ALPHAS[row],
        });
      }
    }
    return out;
  }

  /** The CSS extent the pattern needs. */
  function size() {
    return {
      width: 2 * MARGIN_PX + COLORS.length * PATCH_PX + (COLORS.length - 1) * GAP_PX,
      height: 2 * MARGIN_PX + ALPHAS.length * PATCH_PX + (ALPHAS.length - 1) * GAP_PX,
    };
  }

  /** Draws on a WebGL2 canvas; `scale` is backing pixels per CSS pixel. Returns the context or null. */
  function drawWebGL(canvas, scale) {
    var gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    var list = patches();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var x = Math.round(p.x * scale);
      var w = Math.round((p.x + p.w) * scale) - x;
      var top = Math.round(p.y * scale);
      var h = Math.round((p.y + p.h) * scale) - top;
      gl.scissor(x, canvas.height - top - h, w, h);
      gl.clearColor((p.color[0] / 255) * p.alpha, (p.color[1] / 255) * p.alpha, (p.color[2] / 255) * p.alpha, p.alpha);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.SCISSOR_TEST);
    return gl;
  }

  /** Draws on a Canvas 2D canvas; `scale` is backing pixels per CSS pixel. Returns the context or null. */
  function draw2D(canvas, scale) {
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var list = patches();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var x = Math.round(p.x * scale);
      var y = Math.round(p.y * scale);
      ctx.fillStyle = "rgba(" + p.color[0] + "," + p.color[1] + "," + p.color[2] + "," + p.alpha + ")";
      ctx.fillRect(x, y, Math.round((p.x + p.w) * scale) - x, Math.round((p.y + p.h) * scale) - y);
    }
    return ctx;
  }

  root.probePattern = {
    PATCH_PX: PATCH_PX,
    ALPHAS: ALPHAS,
    COLORS: COLORS,
    patches: patches,
    size: size,
    drawWebGL: drawWebGL,
    draw2D: draw2D,
  };
})(globalThis);
