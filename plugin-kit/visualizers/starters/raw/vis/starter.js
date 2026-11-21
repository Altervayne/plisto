// A raw kind: you own the canvas. Return it from `setup` and Plisto takes the still from it and watches it
// for flashing after each `frame` call.
(() => {
  let canvas = null;
  let g = null;
  let width = 0;
  let height = 0;
  let ink = "rgb(120, 120, 120)";

  const fit = (layout) => {
    const dpr = window.devicePixelRatio || 1;
    width = layout.width;
    height = layout.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const readInk = (colors) => {
    ink = `rgb(${colors.ink.map((v) => Math.round(v * 255)).join(", ")})`;
  };

  // A still frame has no bands; draw a calm shallow arch.
  const draw = (bands) => {
    g.clearRect(0, 0, width, height);
    g.fillStyle = ink;
    g.globalAlpha = 0.35;
    const w = width / bands.length;
    bands.forEach((v, i) => {
      const h = Math.min(1, v) * height * 0.5;
      g.fillRect(i * w + 2, height - h, w - 4, h);
    });
  };

  const resting = Array.from({ length: 24 }, (_, i) => 0.05 + 0.1 * Math.sin((Math.PI * i) / 23));

  plistoVis.raw({
    setup(ctx) {
      canvas = document.createElement("canvas");
      canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block";
      document.body.appendChild(canvas);
      g = canvas.getContext("2d");
      fit(ctx.layout);
      readInk(ctx.colors);
      return canvas;
    },
    frame(f) {
      draw(f.still || f.rawBands.length === 0 ? resting : f.rawBands);
    },
    resize: fit,
    theme(ctx) {
      readInk(ctx.colors);
    },
    dispose() {
      canvas.remove();
    },
  });
})();
