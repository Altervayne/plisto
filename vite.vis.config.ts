import { defineConfig } from "vite";

// The plugin visualizer runtime: one classic script exposing the global `plistoVis`, unminified so a plugin
// author can read it. Built and checked by tools/vis-bundle.mjs, never by the app build.
export default defineConfig({
  publicDir: false,
  logLevel: "warn",
  build: {
    lib: {
      entry: "src/visRuntime/index.ts",
      name: "plistoVis",
      formats: ["iife"],
      fileName: () => "plisto-vis-1.js",
    },
    outDir: "plugin-kit/visualizers/runtime",
    emptyOutDir: false,
    copyPublicDir: false,
    minify: false,
    target: "es2020",
    reportCompressedSize: false,
  },
});
